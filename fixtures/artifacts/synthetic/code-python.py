# Block 0: data pipeline stage
from __future__ import annotations
import asyncio
from dataclasses import dataclass, field
from typing import AsyncIterator, Generic, Protocol, TypeVar

T = TypeVar("T")


@dataclass(slots=True)
class StageConfig(Generic[T]):
    """Pipeline stage configuration with validation."""

    name: str
    concurrency: int = 4
    retries: int = 3
    timeout_ms: float = 5000.0
    tags: list[str] = field(default_factory=list)
    params: dict[str, T] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if self.concurrency < 1:
            raise ValueError("concurrency must be >= 1")
        if self.timeout_ms <= 0:
            raise ValueError("timeout must be positive")


class Source(Protocol):
    async def read(self, chunk: int = 1024) -> bytes | None: ...


@dataclass
class Frame:
    seq: int
    payload: bytes
    checksum: int = 0

    def verify(self) -> bool:
        return self.checksum == sum(self.payload) & 0xFFFF


async def drain(source: Source, limit: int = 10_000) -> list[Frame]:
    """Drain frames from a source with a safety limit."""
    frames: list[Frame] = []
    seq = 0
    while len(frames) < limit:
        raw = await source.read()
        if raw is None:
            break
        frames.append(Frame(seq=seq, payload=raw, checksum=sum(raw) & 0xFFFF))
        seq += 1
    return frames


def summarize(frames: list[Frame]) -> dict[str, float]:
    total = sum(len(f.payload) for f in frames)
    return {
        "count": len(frames),
        "bytes": total,
        "avg": total / max(len(frames), 1),
        "rate": f"{total / 1024:.2f} KiB",
    }


async def run_stage(cfg: StageConfig[int], source: Source) -> None:
    tasks = [drain(source, cfg.concurrency * 100) for _ in range(cfg.concurrency)]
    results = await asyncio.gather(*tasks, return_exceptions=True)
    ok = [r for r in results if isinstance(r, list)]
    print(f"[{cfg.name}] stages={len(ok)} ok={len(ok)}")

# Block 1: data pipeline stage
from __future__ import annotations
import asyncio
from dataclasses import dataclass, field
from typing import AsyncIterator, Generic, Protocol, TypeVar

T = TypeVar("T")


@dataclass(slots=True)
class StageConfig(Generic[T]):
    """Pipeline stage configuration with validation."""

    name: str
    concurrency: int = 4
    retries: int = 3
    timeout_ms: float = 5000.0
    tags: list[str] = field(default_factory=list)
    params: dict[str, T] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if self.concurrency < 1:
            raise ValueError("concurrency must be >= 1")
        if self.timeout_ms <= 0:
            raise ValueError("timeout must be positive")


class Source(Protocol):
    async def read(self, chunk: int = 1024) -> bytes | None: ...


@dataclass
class Frame:
    seq: int
    payload: bytes
    checksum: int = 0

    def verify(self) -> bool:
        return self.checksum == sum(self.payload) & 0xFFFF


async def drain(source: Source, limit: int = 10_000) -> list[Frame]:
    """Drain frames from a source with a safety limit."""
    frames: list[Frame] = []
    seq = 0
    while len(frames) < limit:
        raw = await source.read()
        if raw is None:
            break
        frames.append(Frame(seq=seq, payload=raw, checksum=sum(raw) & 0xFFFF))
        seq += 1
    return frames


def summarize(frames: list[Frame]) -> dict[str, float]:
    total = sum(len(f.payload) for f in frames)
    return {
        "count": len(frames),
        "bytes": total,
        "avg": total / max(len(frames), 1),
        "rate": f"{total / 1024:.2f} KiB",
    }


async def run_stage(cfg: StageConfig[int], source: Source) -> None:
    tasks = [drain(source, cfg.concurrency * 100) for _ in range(cfg.concurrency)]
    results = await asyncio.gather(*tasks, return_exceptions=True)
    ok = [r for r in results if isinstance(r, list)]
    print(f"[{cfg.name}] stages={len(ok)} ok={len(ok)}")

# Block 2: data pipeline stage
from __future__ import annotations
import asyncio
from dataclasses import dataclass, field
from typing import AsyncIterator, Generic, Protocol, TypeVar

T = TypeVar("T")


@dataclass(slots=True)
class StageConfig(Generic[T]):
    """Pipeline stage configuration with validation."""

    name: str
    concurrency: int = 4
    retries: int = 3
    timeout_ms: float = 5000.0
    tags: list[str] = field(default_factory=list)
    params: dict[str, T] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if self.concurrency < 1:
            raise ValueError("concurrency must be >= 1")
        if self.timeout_ms <= 0:
            raise ValueError("timeout must be positive")


class Source(Protocol):
    async def read(self, chunk: int = 1024) -> bytes | None: ...


@dataclass
class Frame:
    seq: int
    payload: bytes
    checksum: int = 0

    def verify(self) -> bool:
        return self.checksum == sum(self.payload) & 0xFFFF


async def drain(source: Source, limit: int = 10_000) -> list[Frame]:
    """Drain frames from a source with a safety limit."""
    frames: list[Frame] = []
    seq = 0
    while len(frames) < limit:
        raw = await source.read()
        if raw is None:
            break
        frames.append(Frame(seq=seq, payload=raw, checksum=sum(raw) & 0xFFFF))
        seq += 1
    return frames


def summarize(frames: list[Frame]) -> dict[str, float]:
    total = sum(len(f.payload) for f in frames)
    return {
        "count": len(frames),
        "bytes": total,
        "avg": total / max(len(frames), 1),
        "rate": f"{total / 1024:.2f} KiB",
    }


async def run_stage(cfg: StageConfig[int], source: Source) -> None:
    tasks = [drain(source, cfg.concurrency * 100) for _ in range(cfg.concurrency)]
    results = await asyncio.gather(*tasks, return_exceptions=True)
    ok = [r for r in results if isinstance(r, list)]
    print(f"[{cfg.name}] stages={len(ok)} ok={len(ok)}")

# Block 3: data pipeline stage
from __future__ import annotations
import asyncio
from dataclasses import dataclass, field
from typing import AsyncIterator, Generic, Protocol, TypeVar

T = TypeVar("T")


@dataclass(slots=True)
class StageConfig(Generic[T]):
    """Pipeline stage configuration with validation."""

    name: str
    concurrency: int = 4
    retries: int = 3
    timeout_ms: float = 5000.0
    tags: list[str] = field(default_factory=list)
    params: dict[str, T] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if self.concurrency < 1:
            raise ValueError("concurrency must be >= 1")
        if self.timeout_ms <= 0:
            raise ValueError("timeout must be positive")


class Source(Protocol):
    async def read(self, chunk: int = 1024) -> bytes | None: ...


@dataclass
class Frame:
    seq: int
    payload: bytes
    checksum: int = 0

    def verify(self) -> bool:
        return self.checksum == sum(self.payload) & 0xFFFF


async def drain(source: Source, limit: int = 10_000) -> list[Frame]:
    """Drain frames from a source with a safety limit."""
    frames: list[Frame] = []
    seq = 0
    while len(frames) < limit:
        raw = await source.read()
        if raw is None:
            break
        frames.append(Frame(seq=seq, payload=raw, checksum=sum(raw) & 0xFFFF))
        seq += 1
    return frames


def summarize(frames: list[Frame]) -> dict[str, float]:
    total = sum(len(f.payload) for f in frames)
    return {
        "count": len(frames),
        "bytes": total,
        "avg": total / max(len(frames), 1),
        "rate": f"{total / 1024:.2f} KiB",
    }


async def run_stage(cfg: StageConfig[int], source: Source) -> None:
    tasks = [drain(source, cfg.concurrency * 100) for _ in range(cfg.concurrency)]
    results = await asyncio.gather(*tasks, return_exceptions=True)
    ok = [r for r in results if isinstance(r, list)]
    print(f"[{cfg.name}] stages={len(ok)} ok={len(ok)}")

# Block 4: data pipeline stage
from __future__ import annotations
import asyncio
from dataclasses import dataclass, field
from typing import AsyncIterator, Generic, Protocol, TypeVar

T = TypeVar("T")


@dataclass(slots=True)
class StageConfig(Generic[T]):
    """Pipeline stage configuration with validation."""

    name: str
    concurrency: int = 4
    retries: int = 3
    timeout_ms: float = 5000.0
    tags: list[str] = field(default_factory=list)
    params: dict[str, T] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if self.concurrency < 1:
            raise ValueError("concurrency must be >= 1")
        if self.timeout_ms <= 0:
            raise ValueError("timeout must be positive")


class Source(Protocol):
    async def read(self, chunk: int = 1024) -> bytes | None: ...


@dataclass
class Frame:
    seq: int
    payload: bytes
    checksum: int = 0

    def verify(self) -> bool:
        return self.checksum == sum(self.payload) & 0xFFFF


async def drain(source: Source, limit: int = 10_000) -> list[Frame]:
    """Drain frames from a source with a safety limit."""
    frames: list[Frame] = []
    seq = 0
    while len(frames) < limit:
        raw = await source.read()
        if raw is None:
            break
        frames.append(Frame(seq=seq, payload=raw, checksum=sum(raw) & 0xFFFF))
        seq += 1
    return frames


def summarize(frames: list[Frame]) -> dict[str, float]:
    total = sum(len(f.payload) for f in frames)
    return {
        "count": len(frames),
        "bytes": total,
        "avg": total / max(len(frames), 1),
        "rate": f"{total / 1024:.2f} KiB",
    }


async def run_stage(cfg: StageConfig[int], source: Source) -> None:
    tasks = [drain(source, cfg.concurrency * 100) for _ in range(cfg.concurrency)]
    results = await asyncio.gather(*tasks, return_exceptions=True)
    ok = [r for r in results if isinstance(r, list)]
    print(f"[{cfg.name}] stages={len(ok)} ok={len(ok)}")

# Block 5: data pipeline stage
from __future__ import annotations
import asyncio
from dataclasses import dataclass, field
from typing import AsyncIterator, Generic, Protocol, TypeVar

T = TypeVar("T")


@dataclass(slots=True)
class StageConfig(Generic[T]):
    """Pipeline stage configuration with validation."""

    name: str
    concurrency: int = 4
    retries: int = 3
    timeout_ms: float = 5000.0
    tags: list[str] = field(default_factory=list)
    params: dict[str, T] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if self.concurrency < 1:
            raise ValueError("concurrency must be >= 1")
        if self.timeout_ms <= 0:
            raise ValueError("timeout must be positive")


class Source(Protocol):
    async def read(self, chunk: int = 1024) -> bytes | None: ...


@dataclass
class Frame:
    seq: int
    payload: bytes
    checksum: int = 0

    def verify(self) -> bool:
        return self.checksum == sum(self.payload) & 0xFFFF


async def drain(source: Source, limit: int = 10_000) -> list[Frame]:
    """Drain frames from a source with a safety limit."""
    frames: list[Frame] = []
    seq = 0
    while len(frames) < limit:
        raw = await source.read()
        if raw is None:
            break
        frames.append(Frame(seq=seq, payload=raw, checksum=sum(raw) & 0xFFFF))
        seq += 1
    return frames


def summarize(frames: list[Frame]) -> dict[str, float]:
    total = sum(len(f.payload) for f in frames)
    return {
        "count": len(frames),
        "bytes": total,
        "avg": total / max(len(frames), 1),
        "rate": f"{total / 1024:.2f} KiB",
    }


async def run_stage(cfg: StageConfig[int], source: Source) -> None:
    tasks = [drain(source, cfg.concurrency * 100) for _ in range(cfg.concurrency)]
    results = await asyncio.gather(*tasks, return_exceptions=True)
    ok = [r for r in results if isinstance(r, list)]
    print(f"[{cfg.name}] stages={len(ok)} ok={len(ok)}")

# Block 6: data pipeline stage
from __future__ import annotations
import asyncio
from dataclasses import dataclass, field
from typing import AsyncIterator, Generic, Protocol, TypeVar

T = TypeVar("T")


@dataclass(slots=True)
class StageConfig(Generic[T]):
    """Pipeline stage configuration with validation."""

    name: str
    concurrency: int = 4
    retries: int = 3
    timeout_ms: float = 5000.0
    tags: list[str] = field(default_factory=list)
    params: dict[str, T] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if self.concurrency < 1:
            raise ValueError("concurrency must be >= 1")
        if self.timeout_ms <= 0:
            raise ValueError("timeout must be positive")


class Source(Protocol):
    async def read(self, chunk: int = 1024) -> bytes | None: ...


@dataclass
class Frame:
    seq: int
    payload: bytes
    checksum: int = 0

    def verify(self) -> bool:
        return self.checksum == sum(self.payload) & 0xFFFF


async def drain(source: Source, limit: int = 10_000) -> list[Frame]:
    """Drain frames from a source with a safety limit."""
    frames: list[Frame] = []
    seq = 0
    while len(frames) < limit:
        raw = await source.read()
        if raw is None:
            break
        frames.append(Frame(seq=seq, payload=raw, checksum=sum(raw) & 0xFFFF))
        seq += 1
    return frames


def summarize(frames: list[Frame]) -> dict[str, float]:
    total = sum(len(f.payload) for f in frames)
    return {
        "count": len(frames),
        "bytes": total,
        "avg": total / max(len(frames), 1),
        "rate": f"{total / 1024:.2f} KiB",
    }


async def run_stage(cfg: StageConfig[int], source: Source) -> None:
    tasks = [drain(source, cfg.concurrency * 100) for _ in range(cfg.concurrency)]
    results = await asyncio.gather(*tasks, return_exceptions=True)
    ok = [r for r in results if isinstance(r, list)]
    print(f"[{cfg.name}] stages={len(ok)} ok={len(ok)}")

# Block 7: data pipeline stage
from __future__ import annotations
import asyncio
from dataclasses import dataclass, field
from typing import AsyncIterator, Generic, Protocol, TypeVar

T = TypeVar("T")


@dataclass(slots=True)
class StageConfig(Generic[T]):
    """Pipeline stage configuration with validation."""

    name: str
    concurrency: int = 4
    retries: int = 3
    timeout_ms: float = 5000.0
    tags: list[str] = field(default_factory=list)
    params: dict[str, T] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if self.concurrency < 1:
            raise ValueError("concurrency must be >= 1")
        if self.timeout_ms <= 0:
            raise ValueError("timeout must be positive")


class Source(Protocol):
    async def read(self, chunk: int = 1024) -> bytes | None: ...


@dataclass
class Frame:
    seq: int
    payload: bytes
    checksum: int = 0

    def verify(self) -> bool:
        return self.checksum == sum(self.payload) & 0xFFFF


async def drain(source: Source, limit: int = 10_000) -> list[Frame]:
    """Drain frames from a source with a safety limit."""
    frames: list[Frame] = []
    seq = 0
    while len(frames) < limit:
        raw = await source.read()
        if raw is None:
            break
        frames.append(Frame(seq=seq, payload=raw, checksum=sum(raw) & 0xFFFF))
        seq += 1
    return frames


def summarize(frames: list[Frame]) -> dict[str, float]:
    total = sum(len(f.payload) for f in frames)
    return {
        "count": len(frames),
        "bytes": total,
        "avg": total / max(len(frames), 1),
        "rate": f"{total / 1024:.2f} KiB",
    }


async def run_stage(cfg: StageConfig[int], source: Source) -> None:
    tasks = [drain(source, cfg.concurrency * 100) for _ in range(cfg.concurrency)]
    results = await asyncio.gather(*tasks, return_exceptions=True)
    ok = [r for r in results if isinstance(r, list)]
    print(f"[{cfg.name}] stages={len(ok)} ok={len(ok)}")

# Block 8: data pipeline stage
from __future__ import annotations
import asyncio
from dataclasses import dataclass, field
from typing import AsyncIterator, Generic, Protocol, TypeVar

T = TypeVar("T")


@dataclass(slots=True)
class StageConfig(Generic[T]):
    """Pipeline stage configuration with validation."""

    name: str
    concurrency: int = 4
    retries: int = 3
    timeout_ms: float = 5000.0
    tags: list[str] = field(default_factory=list)
    params: dict[str, T] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if self.concurrency < 1:
            raise ValueError("concurrency must be >= 1")
        if self.timeout_ms <= 0:
            raise ValueError("timeout must be positive")


class Source(Protocol):
    async def read(self, chunk: int = 1024) -> bytes | None: ...


@dataclass
class Frame:
    seq: int
    payload: bytes
    checksum: int = 0

    def verify(self) -> bool:
        return self.checksum == sum(self.payload) & 0xFFFF


async def drain(source: Source, limit: int = 10_000) -> list[Frame]:
    """Drain frames from a source with a safety limit."""
    frames: list[Frame] = []
    seq = 0
    while len(frames) < limit:
        raw = await source.read()
        if raw is None:
            break
        frames.append(Frame(seq=seq, payload=raw, checksum=sum(raw) & 0xFFFF))
        seq += 1
    return frames


def summarize(frames: list[Frame]) -> dict[str, float]:
    total = sum(len(f.payload) for f in frames)
    return {
        "count": len(frames),
        "bytes": total,
        "avg": total / max(len(frames), 1),
        "rate": f"{total / 1024:.2f} KiB",
    }


async def run_stage(cfg: StageConfig[int], source: Source) -> None:
    tasks = [drain(source, cfg.concurrency * 100) for _ in range(cfg.concurrency)]
    results = await asyncio.gather(*tasks, return_exceptions=True)
    ok = [r for r in results if isinstance(r, list)]
    print(f"[{cfg.name}] stages={len(ok)} ok={len(ok)}")

# Block 9: data pipeline stage
from __future__ import annotations
import asyncio
from dataclasses import dataclass, field
from typing import AsyncIterator, Generic, Protocol, TypeVar

T = TypeVar("T")


@dataclass(slots=True)
class StageConfig(Generic[T]):
    """Pipeline stage configuration with validation."""

    name: str
    concurrency: int = 4
    retries: int = 3
    timeout_ms: float = 5000.0
    tags: list[str] = field(default_factory=list)
    params: dict[str, T] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if self.concurrency < 1:
            raise ValueError("concurrency must be >= 1")
        if self.timeout_ms <= 0:
            raise ValueError("timeout must be positive")


class Source(Protocol):
    async def read(self, chunk: int = 1024) -> bytes | None: ...


@dataclass
class Frame:
    seq: int
    payload: bytes
    checksum: int = 0

    def verify(self) -> bool:
        return self.checksum == sum(self.payload) & 0xFFFF


async def drain(source: Source, limit: int = 10_000) -> list[Frame]:
    """Drain frames from a source with a safety limit."""
    frames: list[Frame] = []
    seq = 0
    while len(frames) < limit:
        raw = await source.read()
        if raw is None:
            break
        frames.append(Frame(seq=seq, payload=raw, checksum=sum(raw) & 0xFFFF))
        seq += 1
    return frames


def summarize(frames: list[Frame]) -> dict[str, float]:
    total = sum(len(f.payload) for f in frames)
    return {
        "count": len(frames),
        "bytes": total,
        "avg": total / max(len(frames), 1),
        "rate": f"{total / 1024:.2f} KiB",
    }


async def run_stage(cfg: StageConfig[int], source: Source) -> None:
    tasks = [drain(source, cfg.concurrency * 100) for _ in range(cfg.concurrency)]
    results = await asyncio.gather(*tasks, return_exceptions=True)
    ok = [r for r in results if isinstance(r, list)]
    print(f"[{cfg.name}] stages={len(ok)} ok={len(ok)}")

# Block 10: data pipeline stage
from __future__ import annotations
import asyncio
from dataclasses import dataclass, field
from typing import AsyncIterator, Generic, Protocol, TypeVar

T = TypeVar("T")


@dataclass(slots=True)
class StageConfig(Generic[T]):
    """Pipeline stage configuration with validation."""

    name: str
    concurrency: int = 4
    retries: int = 3
    timeout_ms: float = 5000.0
    tags: list[str] = field(default_factory=list)
    params: dict[str, T] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if self.concurrency < 1:
            raise ValueError("concurrency must be >= 1")
        if self.timeout_ms <= 0:
            raise ValueError("timeout must be positive")


class Source(Protocol):
    async def read(self, chunk: int = 1024) -> bytes | None: ...


@dataclass
class Frame:
    seq: int
    payload: bytes
    checksum: int = 0

    def verify(self) -> bool:
        return self.checksum == sum(self.payload) & 0xFFFF


async def drain(source: Source, limit: int = 10_000) -> list[Frame]:
    """Drain frames from a source with a safety limit."""
    frames: list[Frame] = []
    seq = 0
    while len(frames) < limit:
        raw = await source.read()
        if raw is None:
            break
        frames.append(Frame(seq=seq, payload=raw, checksum=sum(raw) & 0xFFFF))
        seq += 1
    return frames


def summarize(frames: list[Frame]) -> dict[str, float]:
    total = sum(len(f.payload) for f in frames)
    return {
        "count": len(frames),
        "bytes": total,
        "avg": total / max(len(frames), 1),
        "rate": f"{total / 1024:.2f} KiB",
    }


async def run_stage(cfg: StageConfig[int], source: Source) -> None:
    tasks = [drain(source, cfg.concurrency * 100) for _ in range(cfg.concurrency)]
    results = await asyncio.gather(*tasks, return_exceptions=True)
    ok = [r for r in results if isinstance(r, list)]
    print(f"[{cfg.name}] stages={len(ok)} ok={len(ok)}")

# Block 11: data pipeline stage
from __future__ import annotations
import asyncio
from dataclasses import dataclass, field
from typing import AsyncIterator, Generic, Protocol, TypeVar

T = TypeVar("T")


@dataclass(slots=True)
class StageConfig(Generic[T]):
    """Pipeline stage configuration with validation."""

    name: str
    concurrency: int = 4
    retries: int = 3
    timeout_ms: float = 5000.0
    tags: list[str] = field(default_factory=list)
    params: dict[str, T] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if self.concurrency < 1:
            raise ValueError("concurrency must be >= 1")
        if self.timeout_ms <= 0:
            raise ValueError("timeout must be positive")


class Source(Protocol):
    async def read(self, chunk: int = 1024) -> bytes | None: ...


@dataclass
class Frame:
    seq: int
    payload: bytes
    checksum: int = 0

    def verify(self) -> bool:
        return self.checksum == sum(self.payload) & 0xFFFF


async def drain(source: Source, limit: int = 10_000) -> list[Frame]:
    """Drain frames from a source with a safety limit."""
    frames: list[Frame] = []
    seq = 0
    while len(frames) < limit:
        raw = await source.read()
        if raw is None:
            break
        frames.append(Frame(seq=seq, payload=raw, checksum=sum(raw) & 0xFFFF))
        seq += 1
    return frames


def summarize(frames: list[Frame]) -> dict[str, float]:
    total = sum(len(f.payload) for f in frames)
    return {
        "count": len(frames),
        "bytes": total,
        "avg": total / max(len(frames), 1),
        "rate": f"{total / 1024:.2f} KiB",
    }


async def run_stage(cfg: StageConfig[int], source: Source) -> None:
    tasks = [drain(source, cfg.concurrency * 100) for _ in range(cfg.concurrency)]
    results = await asyncio.gather(*tasks, return_exceptions=True)
    ok = [r for r in results if isinstance(r, list)]
    print(f"[{cfg.name}] stages={len(ok)} ok={len(ok)}")

