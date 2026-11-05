#!/usr/bin/env python3
"""Read-only MyBuddy prompt-cache usage analysis. Does not read message text."""
import argparse
import datetime as dt
import pathlib
import sqlite3

parser = argparse.ArgumentParser()
parser.add_argument('--task', required=True, help='MyBuddy task ID')
parser.add_argument('--db', default=str(pathlib.Path.home() / '.mybuddy' / 'app.db'))
args = parser.parse_args()
uri = pathlib.Path(args.db).resolve().as_uri() + '?mode=ro'
with sqlite3.connect(uri, uri=True) as db:
    rows = db.execute('''SELECT ts, provider, model, input_tokens, cache_read, cache_write,
                               output_tokens, user_turn, stop_reason
                        FROM usage_events WHERE task_id=? AND source_kind='main'
                        ORDER BY ts, rowid''', (args.task,)).fetchall()
if not rows:
    raise SystemExit('No main-session usage records for this task.')
print('local time | provider/model | turn | input | cache read | cache write | output | hit rate | stop')
prev = None
for ts, provider, model, inp, read, write, out, turn, stop in rows:
    total = (inp or 0) + (read or 0) + (write or 0)
    rate = f'{100 * (read or 0) / total:.1f}%' if total else 'n/a'
    marker = ' <-- zero after a hit' if prev and prev > 0 and not read else ''
    print(f'{dt.datetime.fromtimestamp(ts/1000).isoformat(timespec="seconds")} | {provider}/{model} | {turn} | {inp} | {read} | {write} | {out} | {rate} | {stop}{marker}')
    prev = read
print(f'\nRecords: {len(rows)}. Zero read is a cache miss observation, not proof of a cache purge.')
print('Values depend on provider accounting and may be missing or recorded as zero.')
