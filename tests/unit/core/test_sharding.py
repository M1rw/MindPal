import pytest
from backend.services.core.sharding import ConsistentHash, ShardRouter, ShardKeyGenerator


def test_consistent_hash_basic():
    ch = ConsistentHash(replicas=3)
    ch.add_node("node_0")
    ch.add_node("node_1")

    node = ch.get_node("user_123")
    assert node in ("node_0", "node_1")

    nodes = ch.get_nodes("user_123", count=2)
    assert len(nodes) == 2
    assert set(nodes) == {"node_0", "node_1"}


def test_consistent_hash_empty_raises():
    ch = ConsistentHash(replicas=3)
    with pytest.raises(ValueError, match="No nodes in hash ring"):
        ch.get_node("user_123")


def test_shard_router():
    router = ShardRouter(num_shards=4, replicas=3)
    shard_id = router.get_shard_id("user_456")
    assert 0 <= shard_id < 4

    shard_key = router.get_shard_key("user_456")
    assert shard_key == f"shard_{shard_id}"

    collection = router.get_shard_collection("users", "user_456")
    assert collection == f"users_shard_{shard_id}"

    replicas = router.get_replica_shards("user_456")
    assert len(replicas) == 3


def test_shard_key_generator():
    assert ShardKeyGenerator.for_user("usr_123") == "usr_123"
    assert ShardKeyGenerator.for_request("req_456") == "req_456"
    assert ShardKeyGenerator.for_time_series("usr_123", "2026-08-31T12:00:00Z") == "usr_123:2026-08-31"
    assert ShardKeyGenerator.for_composite(["a", "b", "c"]) == "a:b:c"
