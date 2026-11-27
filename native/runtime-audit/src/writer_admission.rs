use crate::resource_gate::{ResourceGate, ResourceLease, ResourceTicket};
use crate::{
    DB_WRITE_POOL_METRICS, Request, RequestId, Result, WorkerPool, request_control,
    resource_plan_for_request,
};
use std::collections::VecDeque;
use std::io;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

const CAPACITY: usize = 128;
const ADMISSION_TIMEOUT: Duration = Duration::from_secs(30);

struct PendingWrite {
    id: RequestId,
    request: Request,
    ticket: ResourceTicket,
    deadline: Instant,
}

#[derive(Default)]
struct Queue {
    jobs: VecDeque<PendingWrite>,
    closed: bool,
}

struct Admission {
    gate: Arc<ResourceGate>,
    queue: Mutex<Queue>,
    writer_count: usize,
    granted: AtomicUsize,
    failed: AtomicBool,
}

struct WriterSlot(Arc<Admission>);

impl Drop for WriterSlot {
    fn drop(&mut self) {
        if thread::panicking() {
            self.0.failed.store(true, Ordering::Release);
        }
        self.0.granted.fetch_sub(1, Ordering::AcqRel);
        self.0.gate.wake();
    }
}

struct GrantedWrite {
    request: Request,
    lease: ResourceLease,
    _slot: WriterSlot,
}

struct Dispatch {
    ready: Option<(RequestId, GrantedWrite)>,
    rejected: Vec<(RequestId, &'static str)>,
    drained: bool,
    wait: Duration,
}

pub(super) struct DatabaseWriter {
    admission: Arc<Admission>,
    dispatcher: JoinHandle<io::Result<()>>,
}

impl DatabaseWriter {
    pub fn spawn<S: Send + 'static>(
        gate: Arc<ResourceGate>,
        workers: usize,
        make_state: impl Fn() -> S,
        handle: impl Fn(&mut S, RequestId, Request, ResourceLease) -> bool + Send + Sync + 'static,
    ) -> io::Result<Self> {
        let admission = Arc::new(Admission {
            gate,
            queue: Mutex::default(),
            writer_count: workers,
            granted: AtomicUsize::new(0),
            failed: AtomicBool::new(false),
        });
        let execution = admission.clone();
        let pool = WorkerPool::spawn(
            "database-writer",
            workers,
            workers,
            &DB_WRITE_POOL_METRICS,
            make_state,
            move |state,
                  id,
                  GrantedWrite {
                      request,
                      lease,
                      _slot,
                  }| {
                if execution.failed.load(Ordering::Acquire) {
                    let _ = request_control::reject_pending(&id, "UNAVAILABLE");
                    return false;
                }
                let keep_going = handle(state, id, request, lease);
                if !keep_going {
                    execution.failed.store(true, Ordering::Release);
                }
                keep_going
            },
        )?;
        let driver = admission.clone();
        let dispatcher = thread::Builder::new()
            .name("database-admission".into())
            .spawn(move || driver.run(pool))?;
        Ok(Self {
            admission,
            dispatcher,
        })
    }

    pub fn try_send(
        &self,
        id: RequestId,
        request: Request,
    ) -> std::result::Result<(), (RequestId, &'static str)> {
        let mut queue = self
            .admission
            .queue
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if queue.closed || self.admission.failed.load(Ordering::Acquire) {
            return Err((id, "UNAVAILABLE"));
        }
        if queue.jobs.len() >= CAPACITY {
            DB_WRITE_POOL_METRICS
                .overloaded
                .fetch_add(1, Ordering::AcqRel);
            return Err((id, "OVERLOADED"));
        }
        let ticket = match self
            .admission
            .gate
            .enqueue(resource_plan_for_request(&request))
        {
            Ok(ticket) => ticket,
            Err(_) => {
                DB_WRITE_POOL_METRICS
                    .overloaded
                    .fetch_add(1, Ordering::AcqRel);
                return Err((id, "OVERLOADED"));
            }
        };
        queue.jobs.push_back(PendingWrite {
            id,
            request,
            ticket,
            deadline: Instant::now() + ADMISSION_TIMEOUT,
        });
        let queued = queue.jobs.len();
        DB_WRITE_POOL_METRICS
            .queued
            .store(queued, Ordering::Release);
        DB_WRITE_POOL_METRICS
            .max_queued
            .fetch_max(queued, Ordering::AcqRel);
        Ok(())
    }

    pub fn shutdown(self) -> Result<()> {
        self.admission
            .queue
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .closed = true;
        self.admission.gate.wake();
        self.dispatcher
            .join()
            .map_err(|_| "database admission panicked")?
            .map_err(Into::into)
    }
}

impl Admission {
    fn select(self: &Arc<Self>) -> Dispatch {
        let mut queue = self.queue.lock().unwrap_or_else(|e| e.into_inner());
        let mut rejected = Vec::new();
        let failed = self.failed.load(Ordering::Acquire);
        let now = Instant::now();
        let control = request_control::shared();
        queue.jobs.retain(|job| {
            if job.deadline <= now
                || job.id.as_deref().is_some_and(|id| {
                    control
                        .as_ref()
                        .is_some_and(|control| control.is_cancelled_or_expired(id))
                })
            {
                rejected.push((job.id.clone(), "EXPIRED"));
            } else if failed {
                rejected.push((job.id.clone(), "UNAVAILABLE"));
            } else {
                return true;
            }
            false
        });
        let ready = if !failed && self.granted.load(Ordering::Acquire) < self.writer_count {
            let runnable = queue
                .jobs
                .iter_mut()
                .enumerate()
                .find_map(|(index, job)| job.ticket.try_grant().map(|lease| (index, lease)));
            runnable.and_then(|(index, lease)| {
                let job = queue.jobs.remove(index)?;
                self.granted.fetch_add(1, Ordering::AcqRel);
                Some((
                    job.id,
                    GrantedWrite {
                        request: job.request,
                        lease,
                        _slot: WriterSlot(self.clone()),
                    },
                ))
            })
        } else {
            None
        };
        let queued = queue.jobs.len();
        DB_WRITE_POOL_METRICS
            .queued
            .store(queued, Ordering::Release);
        Dispatch {
            ready,
            rejected,
            drained: (queue.closed || failed) && queued == 0,
            wait: if queued == 0 {
                Duration::from_secs(60)
            } else {
                Duration::from_millis(25)
            },
        }
    }

    fn run(self: Arc<Self>, pool: WorkerPool<GrantedWrite>) -> io::Result<()> {
        loop {
            let generation = self.gate.generation();
            let dispatch = self.select();
            for (id, code) in dispatch.rejected {
                if request_control::reject_pending(&id, code).is_err() {
                    self.failed.store(true, Ordering::Release);
                }
                DB_WRITE_POOL_METRICS
                    .completed
                    .fetch_add(1, Ordering::AcqRel);
            }
            if let Some((id, granted)) = dispatch.ready {
                if let Err((id, code)) = pool.try_send(id, granted) {
                    self.failed.store(true, Ordering::Release);
                    let _ = request_control::reject_pending(&id, code);
                    DB_WRITE_POOL_METRICS
                        .completed
                        .fetch_add(1, Ordering::AcqRel);
                }
            } else if !dispatch.drained {
                // Cancellation and deadline state also changes outside the resource gate.
                self.gate.wait_for_change(generation, dispatch.wait);
            }
            if dispatch.drained {
                break;
            }
        }
        if self.failed.load(Ordering::Acquire) {
            let ready = {
                let (lock, cv) = &*pool.shared;
                let mut queue = lock.lock().unwrap_or_else(|e| e.into_inner());
                queue.closed = true;
                cv.notify_all();
                std::mem::take(&mut queue.items)
            };
            for (id, _granted) in ready {
                let _ = request_control::reject_pending(&id, "UNAVAILABLE");
                DB_WRITE_POOL_METRICS
                    .completed
                    .fetch_add(1, Ordering::AcqRel);
            }
        }
        pool.shutdown()
            .map_err(|error| io::Error::other(error.to_string()))
    }
}
