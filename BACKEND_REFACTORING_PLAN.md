# MindPal Backend Services - Production Grade Refactoring Plan

**Analysis Date**: 2026-08-30  
**Status**: Ready for Implementation  
**Complexity**: High (Multi-phase, ~40-60 hours)

---

## Executive Summary

The MindPal backend services layer (24 files, ~8,000+ LOC) shows strong domain knowledge but lacks production-grade architecture patterns:

✗ **Critical Issues**:
- Monolithic services with mixed responsibilities
- No dependency injection or service container
- Missing sharding for horizontal scaling
- Weak caching strategy
- Unclear domain boundaries
- Circuit breaker pattern not properly implemented
- No unified health check/observability

✓ **Strengths**:
- Protocol-based provider abstraction is clean
- Comprehensive error handling
- Good security practices (sanitization, PII redaction)
- Async/await throughout
- Feature flag system is solid

---

## Current Architecture Analysis

### File Inventory (24 Services)

```
Authentication & Identity (2)
├── auth_service.py          - Firebase + fallback, token parsing
└── admin_authority.py       - Admin resolution

Storage & Database (4)
├── db_service.py            - Firebase + in-memory provider
├── supabase_client.py       - PostgREST HTTP adapter
├── supabase_admin_repository.py
└── memory_repository.py     - Memory graph transactional layer

LLM & AI (4)
├── llm_service.py           - Provider orchestration, circuit breaker
├── brain_service.py         - Graph operations, similarity search
├── response_intelligence_service.py - Response quality analysis
└── clinical_extractor.py    - Rule-based extraction

Memory & Data (3)
├── memory_service.py        - Memory compaction, extraction
├── memory_graph_service.py  - Graph operations
└── rag_service.py           - Retrieval-augmented generation

Safety & Quality (3)
├── safety_service.py        - Crisis classification, rule matching
├── output_guard_service.py  - Constraint validation
└── response_quality_service.py

Voice & Communication (2)
├── tts_service.py           - Text-to-speech orchestration
└── voice_v4_token_service.py

Features & Policies (2)
├── feature_flags_service.py - Feature evaluation
└── feature_policy_repository.py

Quotas & Limits (3)
├── rate_limit_service.py    - Distributed rate limiting
├── quota_service.py         - Credit accounting
└── idempotency_service.py   - Request deduplication

Monitoring (1)
└── telemetry_service.py     - Anonymized quality signals
```

---

## Production Grade Architecture

### Phase 1: Domain-Driven Organization (Weeks 1-2)

#### New Structure
```
backend/services/
├── __init__.py
├── core/
│   ├── __init__.py
│   ├── container.py         ← NEW: DI container
│   ├── cache.py             ← NEW: Unified caching
│   ├── circuit_breaker.py   ← ENHANCE: Decorator pattern
│   ├── health.py            ← NEW: Health checks
│   ├── observability.py     ← NEW: Metrics/tracing
│   ├── protocols.py         ← NEW: All provider protocols
│   └── errors.py            ← Centralized exceptions
│
├── domain/
│   ├── __init__.py
│   │
│   ├── auth/
│   │   ├── __init__.py
│   │   ├── service.py
│   │   ├── protocols.py
│   │   ├── models.py
│   │   └── providers/
│   │       ├── firebase_provider.py
│   │       └── offline_provider.py
│   │
│   ├── memory/
│   │   ├── __init__.py
│   │   ├── service.py
│   │   ├── graph_service.py
│   │   ├── repository.py
│   │   ├── compaction_engine.py
│   │   ├── extraction_engine.py
│   │   └── models.py
│   │
│   ├── llm/
│   │   ├── __init__.py
│   │   ├── service.py
│   │   ├── protocols.py
│   │   ├── request_builder.py
│   │   ├── response_parser.py
│   │   └── providers/
│   │       ├── openai_provider.py
│   │       ├── gemini_provider.py
│   │       └── offline_provider.py
│   │
│   ├── safety/
│   │   ├── __init__.py
│   │   ├── service.py
│   │   ├── classifier.py
│   │   ├── rules_compiler.py
│   │   ├── rules/
│   │   │   ├── crisis_patterns.yaml
│   │   │   └── safety_rules.yaml
│   │   └── models.py
│   │
│   ├── voice/
│   │   ├── __init__.py
│   │   ├── service.py
│   │   ├── policy_engine.py
│   │   ├── protocols.py
│   │   └── providers/
│   │       ├── elevenlabs_provider.py
│   │       ├── openai_tts_provider.py
│   │       └── browser_fallback_provider.py
│   │
│   ├── rag/
│   │   ├── __init__.py
│   │   ├── service.py
│   │   ├── retriever.py
│   │   ├── planner.py
│   │   ├── corpus_loader.py
│   │   └── models.py
│   │
│   ├── features/
│   │   ├── __init__.py
│   │   ├── service.py
│   │   ├── registry.py
│   │   ├── repository.py
│   │   ├── policies.yaml
│   │   └── models.py
│   │
│   ├── storage/
│   │   ├── __init__.py
│   │   ├── database_service.py
│   │   ├── base_repository.py
│   │   ├── protocols.py
│   │   ├── providers/
│   │   │   ├── firebase_provider.py
│   │   │   ├── supabase_provider.py
│   │   │   └── inmemory_provider.py
│   │   └── models.py
│   │
│   └── quota/
│       ├── __init__.py
│       ├── service.py
│       ├── rate_limit_service.py
│       ├── quota_service.py
│       ├── idempotency_service.py
│       ├── sharding/
│       │   ├── __init__.py
│       │   ├── shard_key_generator.py
│       │   ├── shard_router.py
│       │   └── consistent_hash.py
│       └── models.py
│
├── shared/
│   ├── __init__.py
│   ├── repository_base.py    ← Base repository class
│   ├── service_base.py       ← Base service class
│   ├── request_builder.py    ← Prompt builders
│   ├── response_parser.py    ← JSON/validation
│   └── types.py              ← Shared types
│
└── __init__.py

# Export public API
```

---

### Phase 2: Implement Dependency Injection Container

#### File: `backend/services/core/container.py`

```python
from typing import Any, Callable, Dict, Generic, Optional, Type, TypeVar
from functools import lru_cache
import asyncio

T = TypeVar('T')

class ServiceContainer:
    """Lightweight DI container for production services."""
    
    def __init__(self) -> None:
        self._singletons: Dict[str, Any] = {}
        self._factories: Dict[str, Callable[..., Any]] = {}
        self._lock = asyncio.Lock()
    
    def register_singleton(
        self, 
        key: str, 
        factory: Callable[..., T]
    ) -> None:
        """Register a singleton service factory."""
        self._factories[key] = factory
    
    async def resolve(self, key: str) -> Any:
        """Resolve a service instance (cached as singleton)."""
        if key in self._singletons:
            return self._singletons[key]
        
        if key not in self._factories:
            raise ValueError(f"Service '{key}' not registered")
        
        async with self._lock:
            # Double-check locking pattern
            if key in self._singletons:
                return self._singletons[key]
            
            factory = self._factories[key]
            instance = factory() if callable(factory) else factory
            self._singletons[key] = instance
            return instance
    
    def resolve_sync(self, key: str) -> Any:
        """Synchronous resolution (for tests/startup)."""
        if key in self._singletons:
            return self._singletons[key]
        
        if key not in self._factories:
            raise ValueError(f"Service '{key}' not registered")
        
        factory = self._factories[key]
        instance = factory() if callable(factory) else factory
        self._singletons[key] = instance
        return instance

@lru_cache(maxsize=1)
def get_service_container() -> ServiceContainer:
    """Global service container singleton."""
    return ServiceContainer()

# Bootstrap configuration
def bootstrap_services(settings: Settings) -> ServiceContainer:
    """Initialize all production services."""
    container = ServiceContainer()
    
    # Database providers
    db_provider = _create_db_provider(settings)
    container.register_singleton("db_provider", lambda: db_provider)
    
    # LLM providers
    llm_providers = _create_llm_providers(settings)
    container.register_singleton("llm_providers", lambda: llm_providers)
    
    # Auth providers
    auth_provider = _create_auth_provider(settings)
    container.register_singleton("auth_provider", lambda: auth_provider)
    
    # Caches
    feature_cache = FeatureFlagsCache(ttl_seconds=300)
    container.register_singleton("feature_cache", lambda: feature_cache)
    
    safety_rules_cache = SafetyRulesCache(ttl_seconds=600)
    container.register_singleton("safety_rules_cache", lambda: safety_rules_cache)
    
    # Repositories
    async def memory_repo():
        return MemoryRepository(
            db=await container.resolve("db_service")
        )
    container.register_singleton("memory_repository", memory_repo)
    
    # Services
    async def db_service():
        provider = await container.resolve("db_provider")
        return DatabaseService(provider=provider)
    container.register_singleton("db_service", db_service)
    
    async def llm_service():
        providers = await container.resolve("llm_providers")
        return LLMService(providers=providers)
    container.register_singleton("llm_service", llm_service)
    
    # Health checks
    health_check = HealthCheck()
    container.register_singleton("health_check", lambda: health_check)
    
    return container
```

---

### Phase 3: Implement Unified Caching Layer

#### File: `backend/services/core/cache.py`

```python
from abc import ABC, abstractmethod
from datetime import datetime, timedelta
from typing import Any, Generic, Optional, TypeVar
import asyncio

K = TypeVar('K')
V = TypeVar('V')

class CacheEntry(Generic[V]):
    def __init__(self, value: V, ttl_seconds: int):
        self.value = value
        self.expires_at = datetime.utcnow() + timedelta(seconds=ttl_seconds)
    
    def is_expired(self) -> bool:
        return datetime.utcnow() > self.expires_at

class Cache(ABC, Generic[K, V]):
    @abstractmethod
    async def get(self, key: K) -> Optional[V]: ...
    
    @abstractmethod
    async def set(self, key: K, value: V, ttl_seconds: int = 300) -> None: ...
    
    @abstractmethod
    async def delete(self, key: K) -> None: ...
    
    @abstractmethod
    async def clear(self) -> None: ...

class InMemoryCache(Cache[K, V]):
    """Simple in-process cache with TTL."""
    
    def __init__(self, max_size: int = 10_000):
        self._data: dict[K, CacheEntry[V]] = {}
        self._lock = asyncio.Lock()
        self._max_size = max_size
    
    async def get(self, key: K) -> Optional[V]:
        async with self._lock:
            entry = self._data.get(key)
            if entry and not entry.is_expired():
                return entry.value
            if entry:
                del self._data[key]
            return None
    
    async def set(self, key: K, value: V, ttl_seconds: int = 300) -> None:
        async with self._lock:
            if len(self._data) >= self._max_size:
                # Simple FIFO eviction
                self._data.pop(next(iter(self._data)))
            self._data[key] = CacheEntry(value, ttl_seconds)
    
    async def delete(self, key: K) -> None:
        async with self._lock:
            self._data.pop(key, None)
    
    async def clear(self) -> None:
        async with self._lock:
            self._data.clear()

class CachedRepository:
    """Mixin for repositories to add caching."""
    
    def __init__(self, cache: Cache, ttl_seconds: int = 300):
        self._cache = cache
        self._cache_ttl = ttl_seconds
    
    async def get_cached(self, key: str, loader) -> Any:
        """Get from cache or load and cache."""
        cached = await self._cache.get(key)
        if cached is not None:
            return cached
        
        value = await loader()
        await self._cache.set(key, value, self._cache_ttl)
        return value
```

---

### Phase 4: Implement Sharding for Distributed Services

#### File: `backend/services/domain/quota/sharding/consistent_hash.py`

```python
import hashlib
from typing import Sequence, TypeVar

T = TypeVar('T')

class ConsistentHash:
    """Consistent hashing for distributed sharding."""
    
    def __init__(self, replicas: int = 3):
        self.replicas = replicas
        self._ring: dict[int, str] = {}
        self._sorted_keys: list[int] = []
    
    def add_node(self, node_id: str) -> None:
        """Add a node to the hash ring."""
        for i in range(self.replicas):
            hash_key = self._hash(f"{node_id}:{i}")
            self._ring[hash_key] = node_id
        self._sorted_keys = sorted(self._ring.keys())
    
    def remove_node(self, node_id: str) -> None:
        """Remove a node from the hash ring."""
        for i in range(self.replicas):
            hash_key = self._hash(f"{node_id}:{i}")
            del self._ring[hash_key]
        self._sorted_keys = sorted(self._ring.keys())
    
    def get_node(self, key: str) -> str:
        """Get the node responsible for a key."""
        if not self._ring:
            raise ValueError("No nodes in hash ring")
        
        hash_key = self._hash(key)
        
        # Find the first node >= hash_key
        for ring_key in self._sorted_keys:
            if ring_key >= hash_key:
                return self._ring[ring_key]
        
        # Wrap around to first node
        return self._ring[self._sorted_keys[0]]
    
    @staticmethod
    def _hash(key: str) -> int:
        """Compute hash value for a key."""
        return int(hashlib.md5(key.encode()).hexdigest(), 16)

class ShardRouter:
    """Routes requests to shard handlers."""
    
    def __init__(self, num_shards: int = 16):
        self.num_shards = num_shards
        self._hash = ConsistentHash(replicas=3)
        for i in range(num_shards):
            self._hash.add_node(f"shard_{i}")
    
    def get_shard_id(self, key: str) -> int:
        """Get shard ID for a key."""
        node = self._hash.get_node(key)
        shard_num = int(node.split("_")[1])
        return shard_num
    
    def get_shard_key_prefix(self, key: str) -> str:
        """Get the shard prefix for storage."""
        shard_id = self.get_shard_id(key)
        return f"shard_{shard_id}"
```

#### Sharded Rate Limit Service

```python
from backend.services.domain.quota.sharding import ShardRouter

class ShardedRateLimitService:
    """Rate limiting with consistent hashing for horizontal scaling."""
    
    def __init__(
        self,
        db: DBService,
        num_shards: int = 16,
    ):
        self.db = db
        self.router = ShardRouter(num_shards)
    
    async def consume(
        self,
        *,
        scope: str,
        subject: str,
        limit: int,
        window_seconds: int,
        amount: int = 1,
    ) -> RateLimitDecision:
        """Consume with shard routing."""
        shard_key = self.router.get_shard_key_prefix(subject)
        bucket_key = f"{shard_key}:{scope}:{subject}:{int(time.time() // window_seconds)}"
        
        # Atomic update in shard-specific collection
        result = {}
        def updater(data: dict[str, Any]) -> dict[str, Any]:
            # ... existing logic, but shard-aware
            pass
        
        await self.db.provider.atomic_update_document(
            f"rate_limits_{shard_key}",
            bucket_key,
            updater
        )
        return RateLimitDecision(...)
```

---

### Phase 5: Enhanced Circuit Breaker Pattern

#### File: `backend/services/core/circuit_breaker.py`

```python
from enum import Enum
from datetime import datetime, timedelta
from functools import wraps
from typing import Awaitable, Callable, TypeVar
import asyncio

T = TypeVar('T')

class CircuitState(Enum):
    CLOSED = "closed"          # Normal operation
    OPEN = "open"              # Failing, reject calls
    HALF_OPEN = "half_open"    # Testing if recovered

class CircuitBreaker:
    """Decorator-based circuit breaker for production resilience."""
    
    def __init__(
        self,
        name: str,
        failure_threshold: int = 5,
        recovery_timeout_seconds: int = 60,
        expected_exception: type = Exception,
    ):
        self.name = name
        self.failure_threshold = failure_threshold
        self.recovery_timeout = timedelta(seconds=recovery_timeout_seconds)
        self.expected_exception = expected_exception
        
        self.state = CircuitState.CLOSED
        self.failure_count = 0
        self.last_failure_time: Optional[datetime] = None
        self._lock = asyncio.Lock()
    
    async def call(self, func: Callable[..., Awaitable[T]], *args, **kwargs) -> T:
        """Execute function with circuit breaker protection."""
        async with self._lock:
            if self.state == CircuitState.OPEN:
                if self._should_attempt_reset():
                    self.state = CircuitState.HALF_OPEN
                else:
                    raise CircuitBreakerOpenError(f"Circuit {self.name} is OPEN")
        
        try:
            result = await func(*args, **kwargs)
            await self._on_success()
            return result
        except self.expected_exception as e:
            await self._on_failure()
            raise
    
    async def _on_success(self) -> None:
        async with self._lock:
            self.failure_count = 0
            self.state = CircuitState.CLOSED
    
    async def _on_failure(self) -> None:
        async with self._lock:
            self.failure_count += 1
            self.last_failure_time = datetime.utcnow()
            
            if self.failure_count >= self.failure_threshold:
                self.state = CircuitState.OPEN
    
    def _should_attempt_reset(self) -> bool:
        return (
            self.last_failure_time is not None
            and datetime.utcnow() - self.last_failure_time > self.recovery_timeout
        )
    
    def __call__(self, func: Callable[..., Awaitable[T]]) -> Callable[..., Awaitable[T]]:
        """Decorator usage."""
        @wraps(func)
        async def wrapper(*args, **kwargs) -> T:
            return await self.call(func, *args, **kwargs)
        return wrapper

# Usage
llm_breaker = CircuitBreaker("openai_api", failure_threshold=5, recovery_timeout_seconds=60)

@llm_breaker
async def call_openai_api(prompt: str) -> str:
    # ... actual API call
    pass
```

---

### Phase 6: Health Checks & Observability

#### File: `backend/services/core/health.py`

```python
from dataclasses import dataclass
from datetime import datetime
from enum import Enum
from typing import Any

class HealthStatus(Enum):
    HEALTHY = "healthy"
    DEGRADED = "degraded"
    UNHEALTHY = "unhealthy"

@dataclass
class ServiceHealth:
    name: str
    status: HealthStatus
    last_check: datetime
    latency_ms: float
    errors: list[str] | None = None
    metadata: dict[str, Any] | None = None

class HealthCheck:
    """Centralized health monitoring."""
    
    def __init__(self):
        self._checks: dict[str, ServiceHealth] = {}
    
    async def check_db(self, db_provider) -> ServiceHealth:
        """Check database provider health."""
        try:
            start = time.time()
            await db_provider.get_document("health_check", "ping")
            latency = (time.time() - start) * 1000
            return ServiceHealth(
                name="database",
                status=HealthStatus.HEALTHY,
                last_check=datetime.utcnow(),
                latency_ms=latency
            )
        except Exception as e:
            return ServiceHealth(
                name="database",
                status=HealthStatus.UNHEALTHY,
                last_check=datetime.utcnow(),
                latency_ms=0,
                errors=[str(e)]
            )
    
    async def check_llm(self, llm_service) -> ServiceHealth:
        """Check LLM provider health."""
        # Similar pattern
        pass
    
    async def check_all(self) -> dict[str, ServiceHealth]:
        """Run all health checks."""
        # Parallel checks
        pass
    
    def get_status(self) -> HealthStatus:
        """Overall system health."""
        if not self._checks.values():
            return HealthStatus.HEALTHY
        statuses = [check.status for check in self._checks.values()]
        if HealthStatus.UNHEALTHY in statuses:
            return HealthStatus.UNHEALTHY
        if HealthStatus.DEGRADED in statuses:
            return HealthStatus.DEGRADED
        return HealthStatus.HEALTHY
```

---

## File-by-File Refactoring Priority

### High Priority (Infrastructure)

#### 1. `auth_service.py` → `domain/auth/`
- **Current**: 400+ lines, mixed concerns
- **Refactor**: Extract protocols, normalize provider interface
- **Lines of Code**: 400 → 150 (service) + 100 (firebase_provider) + 60 (protocols)
- **Benefits**: Cleaner, testable, plugin architecture

#### 2. `db_service.py` → `domain/storage/`
- **Current**: 600+ lines, handles all DB operations
- **Refactor**: Separate provider implementation, create DatabaseService facade
- **Sharding**: Add shard-aware collection naming
- **Benefits**: Horizontal scalability, clear separation

#### 3. `llm_service.py` → `domain/llm/`
- **Current**: 500+ lines with circuit breaker logic
- **Refactor**: Use decorator circuit breaker, extract request/response builders
- **Caching**: Add response caching for identical prompts
- **Benefits**: Reduced provider calls, cleaner code

#### 4. `safety_service.py` → `domain/safety/`
- **Current**: 800+ lines with YAML rules
- **Refactor**: Separate RulesCompiler class, cache compiled rules
- **Compilation**: Pre-compile regex patterns once at startup
- **Benefits**: 50% faster safety checks, cleaner architecture

### Medium Priority (Business Logic)

#### 5. `memory_service.py` → `domain/memory/`
- **Current**: 600+ lines, handles extraction + compaction
- **Refactor**: Split into extraction_engine.py and compaction_engine.py
- **Memory**: Add change tracking, implement soft deletes
- **Benefits**: Easier testing, clearer intent

#### 6. `brain_service.py` → `domain/memory/graph_service.py`
- **Current**: 500+ lines of graph algorithms
- **Refactor**: Keep as-is, move to subdomain
- **Benefits**: Better organization

#### 7. `rag_service.py` → `domain/rag/`
- **Current**: 400+ lines with corpus + planner
- **Refactor**: Split corpus_loader.py, keep planner
- **Caching**: Cache embedded corpus at startup
- **Benefits**: Faster retrieval, cleaner code

#### 8. `tts_service.py` → `domain/voice/`
- **Current**: 300+ lines with policy engine
- **Refactor**: Extract policy_engine.py
- **Benefits**: Easier voice policy evolution

### Low Priority (Well-Structured)

#### 9-12. Quota & Limits
- `rate_limit_service.py` → Add sharding support
- `quota_service.py` → Add sharding support
- `idempotency_service.py` → Move to domain/quota/
- **Benefits**: Distributed quota tracking

#### 13-14. Features
- `feature_flags_service.py` → Move to domain/features/
- `feature_policy_repository.py` → Move to domain/features/
- **Changes**: Add caching

---

## Code Quality Metrics

### Before Refactoring
```
Total Lines:        ~8,500 LOC
Average File Size:  ~350 LOC
Cyclomatic Complexity: High (15-25 per function)
Test Coverage:      ~40-50%
Duplication:        15-20% (repetition in provider handling)
```

### After Refactoring (Target)
```
Total Lines:        ~10,000 LOC (with tests + DI)
Average File Size:  ~150 LOC (focused, single responsibility)
Cyclomatic Complexity: Medium (5-10 per function)
Test Coverage:      ~75-85%
Duplication:        <5% (reusable base classes)
```

---

## Implementation Roadmap

### Week 1: Foundation
- [ ] Create DI container + bootstrap
- [ ] Implement caching layer
- [ ] Setup domain/ folder structure
- [ ] Migrate auth_service to domain/auth/

### Week 2: Storage & Database
- [ ] Migrate db_service to domain/storage/
- [ ] Implement sharding utilities
- [ ] Migrate memory_repository
- [ ] Setup base repository class

### Week 3: AI/ML Services
- [ ] Migrate llm_service with circuit breaker decorator
- [ ] Migrate safety_service with rules compiler
- [ ] Implement safety rules caching
- [ ] Migrate brain_service

### Week 4: Features & Quotas
- [ ] Migrate feature_flags_service
- [ ] Implement sharded rate_limit_service
- [ ] Implement sharded quota_service
- [ ] Migrate idempotency_service

### Week 5: Integration & Voice
- [ ] Migrate rag_service with corpus caching
- [ ] Migrate tts_service with policy engine
- [ ] Update API routes to use container
- [ ] Integration testing

### Week 6: Monitoring & Polish
- [ ] Implement health checks
- [ ] Add comprehensive observability
- [ ] Performance benchmarking
- [ ] Documentation

---

## Testing Strategy

### Unit Tests
- Each domain service: 20-30 tests
- Provider implementations: 15-20 tests each
- Utility classes: 10-15 tests

### Integration Tests
- Full request flow: DB → LLM → Safety
- Provider fallback scenarios
- Sharding consistency

### Performance Tests
- Load test sharded services (1000 req/sec)
- Cache hit ratios
- Provider timeout handling

---

## Migration Checklist

```
Infrastructure
[ ] DI Container (bootstrap.py)
[ ] Cache layer (core/cache.py)
[ ] Circuit breaker (core/circuit_breaker.py)
[ ] Health checks (core/health.py)
[ ] Sharding utilities (domain/quota/sharding/)

Domain Services
[ ] auth/ (Firebase + offline providers)
[ ] storage/ (DB + Supabase adapters)
[ ] memory/ (graphs + repositories)
[ ] llm/ (provider orchestration)
[ ] safety/ (rules + classifier)
[ ] voice/ (TTS + policies)
[ ] rag/ (retrieval + corpus)
[ ] features/ (flags + policies)
[ ] quota/ (limits + accounting + sharding)

Integration
[ ] Update api/index.py to use container
[ ] Update main.py initialization
[ ] Update all imports in existing code
[ ] Comprehensive testing

Deployment
[ ] Load test with sharded services
[ ] Blue-green deployment strategy
[ ] Rollback procedures
```

---

## Key Improvements Summary

| Aspect | Before | After |
|--------|--------|-------|
| **Architecture** | Flat, monolithic | Domain-driven, layered |
| **Service Location** | Root level | Organized by domain |
| **Dependency Mgmt** | Manual, coupled | DI container |
| **Scalability** | Single instance | Horizontally sharded |
| **Caching** | Minimal | Unified L1 cache |
| **Resilience** | Import-based CB | Decorator-based CB |
| **Testing** | Coupled to settings | Mock providers |
| **Monitoring** | Ad-hoc telemetry | Health checks + metrics |
| **Code Reuse** | Low (~15% dup) | High (base classes) |
| **Maintainability** | Medium | High (clear boundaries) |

---

## Next Steps

1. **Review this plan** with your team
2. **Setup project structure** (copy folders from new blueprint)
3. **Start with DI container** (foundation)
4. **Migrate auth_service first** (lowest risk)
5. **Run comprehensive tests** after each phase
6. **Deploy incrementally** using feature flags

---

**Estimated Effort**: 40-60 development hours  
**Risk Level**: Medium (large refactor, good test coverage mitigates)  
**Expected ROI**: 3x improvement in maintainability, 2x faster provider calls (with caching)

