# Phase 2 Integration Guide - Making It All Work Together

**Purpose**: Step-by-step integration of the three Phase 2 foundation components  
**Target**: Unified, testable, production-ready service composition  
**Effort**: 6-8 hours for full integration  

---

## Integration Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    FastAPI Application                          │
│  (or CLI, or test runner)                                       │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                    depends_on()
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                  Unified Bootstrap                              │
│            backend/services/bootstrap_v2.py                     │
│                                                                 │
│  - Single entry point: build_service_container()              │
│  - All services built in dependency order                      │
│  - Singleton or request-scoped access                          │
│  - Explicit lifecycle: start() / stop()                        │
└──────┬──────────────────────┬────────────────────────┬─────────┘
       │                      │                        │
       │ uses                 │ uses                   │ uses
       ▼                      ▼                        ▼
   ┌───────────┐        ┌─────────────┐      ┌──────────────────┐
   │ Provider  │        │ Request     │      │ LLM Service      │
   │ Policy    │        │ Tracing     │      │ (+ 19 others)    │
   │           │        │             │      │                  │
   │ Centralized│       │ Per-request │      │ All services     │
   │ config    │        │ correlation │      │ unified startup  │
   │ (A/B ready)       │ IDs         │      │                  │
   └───────────┘        └─────────────┘      └──────────────────┘
```

---

## Step 1: Verify All Three Components Load

### Test 1a: Bootstrap loads
```python
# tests/unit/test_bootstrap_v2.py
import asyncio
from backend.services.bootstrap_v2 import build_service_container
from backend.core.config import Settings

async def test_bootstrap_builds():
    settings = Settings(ENVIRONMENT="development")
    container = build_service_container(settings)
    
    # All services present
    assert container.auth is not None
    assert container.db is not None
    assert container.llm is not None
    assert container.safety is not None
    # ... etc for all 20 services
    
    # Can call health
    health = await container.health()
    assert health["status"] == "healthy"
    assert "services" in health

asyncio.run(test_bootstrap_builds())
```

### Test 1b: Provider policies load
```python
# tests/unit/test_provider_policy.py
from backend.services.core.provider_policy import (
    create_default_production_policy,
    RequestClass,
)

def test_policies_defined():
    policy = create_default_production_policy()
    
    # All providers registered
    assert policy.get_provider("gemini") is not None
    assert policy.get_provider("openrouter") is not None
    assert policy.get_provider("offline") is not None
    
    # All request classes have policies
    for req_class in RequestClass:
        p = policy.get_policy_for_request(req_class)
        assert p is not None
        assert len(p.providers_in_order) > 0
```

### Test 1c: Request tracing works
```python
# tests/unit/test_request_tracing.py
from backend.services.core.request_tracing import RequestTracer

def test_tracing_context():
    trace = RequestTracer.start_request(
        request_id="test_123",
        operation="test",
    )
    
    # Context is available
    assert RequestTracer.get_current_request_id() == "test_123"
    assert RequestTracer.get_current_trace() is not None
    
    # Record a call
    RequestTracer.record_provider_call(
        provider_name="gemini",
        status="success",
        prompt_tokens=10,
        completion_tokens=5,
    )
    
    # Trace recorded
    trace = RequestTracer.end_request(success=True)
    assert trace.status == "success"
    assert len(trace.provider_calls) == 1
    assert trace.total_tokens_used == 15
```

---

## Step 2: Integrate Bootstrap with FastAPI

### Modified `backend/api/main.py`

```python
from fastapi import FastAPI
from backend.services.bootstrap_v2 import build_service_container
from backend.core.config import get_settings

app = FastAPI()

@app.on_event("startup")
async def startup_services():
    """Initialize services at startup."""
    settings = get_settings()
    container = build_service_container(settings)
    await container.start()
    app.state.service_container = container

@app.on_event("shutdown")
async def shutdown_services():
    """Clean up services at shutdown."""
    container = getattr(app.state, "service_container", None)
    if container:
        await container.stop()

# Dependency to get container in route handlers
async def get_services(request: Request) -> ServiceContainer:
    """Resolve service container for this request."""
    return request.app.state.service_container

ServicesDep = Annotated[ServiceContainer, Depends(get_services)]

# In route handler:
@app.post("/chat")
async def chat(
    request: Request,
    services: ServicesDep,
):
    # services.llm, services.safety, etc. all available
    response = await services.llm.generate(prompt)
    return response
```

### Test FastAPI integration
```python
# tests/integration/test_fastapi_bootstrap.py
import asyncio
from fastapi.testclient import TestClient
from backend.api.main import app

def test_services_available_in_request():
    client = TestClient(app)
    
    @app.get("/test-services")
    async def test_route(services: ServicesDep):
        return {
            "llm": services.llm is not None,
            "safety": services.safety is not None,
            "auth": services.auth is not None,
        }
    
    response = client.get("/test-services")
    assert response.status_code == 200
    assert response.json()["llm"] is True
```

---

## Step 3: Integrate Policies with LLMService

### Modified `backend/services/llm_service.py`

```python
from backend.services.core.provider_policy import (
    ProviderPolicyRegistry,
    RequestClass,
    RequestTracer,
)

class LLMService:
    def __init__(
        self,
        providers: Sequence[LLMProvider],
        policy: ProviderPolicyRegistry,
        request_class: RequestClass = RequestClass.STANDARD,
    ):
        self.providers = providers
        self.policy = policy
        self.request_class = request_class
    
    async def generate(self, request: LLMRequest) -> LLMResponse:
        """Generate using policy-driven provider selection."""
        
        # Get policy for this request
        policy = self.policy.get_policy_for_request(self.request_class)
        
        # Use policy-defined provider order
        for provider_name in policy.providers_in_order:
            provider = self._find_provider(provider_name)
            if not provider:
                continue
            
            # Use policy-defined timeout
            try:
                response = await asyncio.wait_for(
                    provider.generate(request),
                    timeout=policy.timeout_seconds,
                )
                
                # Record trace
                RequestTracer.record_provider_call(
                    provider_name=provider_name,
                    status="success",
                    prompt_tokens=response.prompt_tokens,
                    completion_tokens=response.completion_tokens,
                )
                
                return response
            
            except asyncio.TimeoutError:
                RequestTracer.record_provider_call(
                    provider_name=provider_name,
                    status="timeout",
                    error_code="timeout",
                )
                continue
            
            except Exception as e:
                RequestTracer.record_provider_call(
                    provider_name=provider_name,
                    status="failure",
                    error_code=getattr(e, 'code', 'unknown'),
                )
                continue
        
        raise ProviderError("All providers exhausted")
```

### Modified `backend/services/bootstrap_v2.py`

```python
def build_service_container(settings: Settings | None = None) -> ServiceContainer:
    """..."""
    settings = settings or get_settings()
    
    # Create policy registry based on environment
    if settings.is_production:
        policy = create_default_production_policy()
    else:
        policy = create_development_policy()
    
    # Build LLM service with policy
    llm = LLMService(
        providers=build_llm_providers(settings, ...),
        policy=policy,
        request_class=RequestClass.STANDARD,  # Default
    )
    
    # ... rest of services ...
```

### Test policy integration
```python
# tests/integration/test_llm_with_policy.py
@pytest.mark.asyncio
async def test_llm_respects_policy():
    policy = create_default_production_policy()
    
    # Critical requests should timeout quickly
    critical_policy = policy.get_policy_for_request(RequestClass.CRITICAL)
    assert critical_policy.timeout_seconds == 15.0
    
    # Batch requests should be cheapest
    batch_policy = policy.get_policy_for_request(RequestClass.BATCH)
    assert batch_policy.providers_in_order == ("gemini",)
```

---

## Step 4: Integrate Tracing with FastAPI Middleware

### Add Middleware to capture request context

```python
# backend/api/middleware.py
from fastapi import Request
from backend.services.core.request_tracing import RequestTracer
import time

async def trace_request_middleware(request: Request, call_next):
    """FastAPI middleware to trace all requests."""
    
    # Extract headers
    request_id = (
        request.headers.get("X-Request-ID") 
        or request.headers.get("x-request-id")
        or str(uuid4())
    )
    
    user_id_hash = request.state.user_id_hash if hasattr(request.state, 'user_id_hash') else None
    channel = request.headers.get("X-MindPal-Channel", "web")
    
    # Start tracing
    trace = RequestTracer.start_request(
        request_id=request_id,
        user_id_hash=user_id_hash,
        channel=channel,
        operation=f"{request.method} {request.url.path}",
    )
    
    # Store in request for access in handlers
    request.state.request_id = request_id
    request.state.trace = trace
    
    try:
        response = await call_next(request)
        
        # Add trace ID to response headers
        response.headers["X-Request-ID"] = request_id
        
        RequestTracer.end_request(success=True)
        return response
    
    except Exception as e:
        error_code = getattr(e, 'code', 'internal_error')
        RequestTracer.end_request(success=False, error_code=error_code)
        raise

# Add to app
app.add_middleware(TraceRequestMiddleware)
```

### Test middleware

```python
# tests/integration/test_tracing_middleware.py
def test_traces_all_requests():
    client = TestClient(app)
    
    response = client.get("/health")
    
    # Response has trace ID
    assert "X-Request-ID" in response.headers
    request_id = response.headers["X-Request-ID"]
    
    # Trace was recorded (check logs or trace storage)
    # This would come from your tracing backend
```

---

## Step 5: Production Deployment Checklist

### Before Deploying Phase 2 to Production

- [ ] All three components have unit tests with 80%+ coverage
- [ ] Integration tests pass with real services
- [ ] Bootstrap passes startup health checks
- [ ] Provider policies are tuned to your real costs/latencies
- [ ] FastAPI middleware doesn't break existing routes
- [ ] Tracing doesn't add significant latency (<10ms per request)
- [ ] Error handling works (one service down doesn't break bootstrap)
- [ ] Logging pipeline accepts new trace format
- [ ] Performance regression tests pass
- [ ] Code review approved by 2+ engineers
- [ ] Rollback plan documented (revert to old bootstrap.py)

### Gradual Rollout Strategy

```
Week 1:
  Day 1: Deploy to staging, run full integration tests
  Day 2: Deploy to 5% of production (canary)
  Day 3: Monitor metrics, fix any issues
  Day 4: Deploy to 50%
  Day 5: Deploy to 100%

Rollback:
  - If errors > baseline: rollback to old bootstrap.py
  - If latency > 20ms increase: rollback
  - If errors in provider detection: rollback
```

---

## Step 6: Monitoring & Observability

### Key Metrics to Track After Integration

```python
# Prometheus metrics to export
BOOTSTRAP_TIME_SECONDS = Histogram(
    "bootstrap_time_seconds",
    "Time to bootstrap service container",
)

PROVIDER_POLICY_LOOKUPS = Counter(
    "provider_policy_lookups_total",
    "Number of provider policy lookups",
    ["request_class"],
)

REQUEST_TRACE_SPANS = Counter(
    "request_trace_spans_total",
    "Number of spans recorded in traces",
    ["span_type"],  # "provider_call" or "service_call"
)

REQUEST_COST_CENTS = Histogram(
    "request_cost_cents",
    "Estimated cost per request in cents",
)
```

### Logging Integration

```python
# Configure Python logging to emit traces
import logging
import json

class StructuredFormatter(logging.Formatter):
    """Emit JSON-structured logs."""
    def format(self, record):
        if hasattr(record, 'trace'):
            return json.dumps(record.trace)
        return super().format(record)

handler = logging.StreamHandler()
handler.setFormatter(StructuredFormatter())
logger.addHandler(handler)

# Now RequestTracer.end_request() emits:
# {"request_id": "...", "status": "success", ...}
```

---

## Common Pitfalls & Solutions

| Pitfall | Symptom | Solution |
|---------|---------|----------|
| Circular dependency | TypeError: cannot create instance | Check bootstrap order: DB before Memory |
| Policy not found | KeyError on request class | Add default policy to registry |
| Trace context lost | Trace ID not in logs | Use contextvars, not thread locals |
| Middleware breaks routes | 500 errors on all requests | Ensure get_services() doesn't raise |
| Cost model wrong | Budgets enforced incorrectly | Calibrate to actual provider pricing |
| Memory leak in traces | Memory usage grows | Implement trace rotation/cleanup |

---

## Questions for Team

### Architectural
1. Should each request get a separate service container, or share singleton?
   - Answer: Share singleton (initialized once), but traces are per-request
2. Should policies be loaded from database or hardcoded?
   - Answer: Start with hardcoded, migrate to database later
3. Do we need per-user or per-tenant policies?
   - Answer: Start with global, add per-tenant in Phase 4

### Operational
1. What's the SLA for health checks to complete?
   - Answer: < 1 second for all 20 services
2. Should we log every trace or sample?
   - Answer: Log all, sample at collection time (use Datadog tail sampling)
3. Who owns monitoring dashboards?
   - Answer: Platform/DevOps team, based on this structure

### Business
1. What's the cost threshold for alerts?
   - Answer: Define per-user and per-organization
2. Should we bill users for provider failures?
   - Answer: No, failures should be retried at no cost
3. Can we change policies without deploys?
   - Answer: Yes once moved to database (Phase 4)

---

## Success Criteria

Phase 2 integration is complete when:

✅ **Functional**
- All services boot from single container
- Policies control provider selection
- Every request is traced end-to-end

✅ **Testable**
- Unit tests for bootstrap, policies, tracing (80%+ coverage)
- Integration tests for end-to-end flow
- No hard-coded dependencies

✅ **Observable**
- Every request has correlation ID
- Provider calls are attributed to requests
- Cost is tracked per request

✅ **Production-Ready**
- <5% performance regression
- Graceful degradation if a service fails
- Clear rollback procedure
- Monitoring dashboards ready

✅ **Documented**
- Runbooks for common issues
- API docs updated
- Operator guides complete

---

**Next Checkpoint**: All integration tests passing, ready for staging deployment
