# Distributed Sharding Utilities

from typing import Optional, Sequence, TypeVar
import hashlib
import logging

logger = logging.getLogger(__name__)

T = TypeVar('T')


class ConsistentHash:
    """
    Consistent hashing ring for distributed data.
    
    Enables:
    - Adding/removing nodes without reshuffling data
    - Minimal data migration on topology changes
    - Load balancing across shards
    
    Uses virtual nodes (replicas) to improve distribution.
    """
    
    def __init__(self, replicas: int = 3):
        """
        Initialize hash ring.
        
        Args:
            replicas: # virtual nodes per physical node
                     Higher = better distribution but more memory
        """
        self.replicas = replicas
        self._ring: dict[int, str] = {}
        self._sorted_keys: list[int] = []
    
    def add_node(self, node_id: str) -> None:
        """Add a node to the hash ring."""
        if not node_id:
            raise ValueError("node_id cannot be empty")
        
        nodes_before = len(set(self._ring.values()))
        
        for i in range(self.replicas):
            hash_key = self._hash(f"{node_id}:{i}")
            self._ring[hash_key] = node_id
        
        self._sorted_keys = sorted(self._ring.keys())
        
        nodes_after = len(set(self._ring.values()))
        logger.debug(f"Added node {node_id} to hash ring ({nodes_before} → {nodes_after} nodes)")
    
    def remove_node(self, node_id: str) -> None:
        """Remove a node from the hash ring."""
        if not node_id:
            return
        
        nodes_before = len(set(self._ring.values()))
        
        # Find and remove all virtual nodes for this node
        keys_to_remove = [
            key for key, node in self._ring.items()
            if node == node_id
        ]
        
        for key in keys_to_remove:
            del self._ring[key]
        
        self._sorted_keys = sorted(self._ring.keys())
        
        nodes_after = len(set(self._ring.values()))
        logger.debug(f"Removed node {node_id} from hash ring ({nodes_before} → {nodes_after} nodes)")
    
    def get_node(self, key: str) -> str:
        """
        Get the node responsible for a key.
        
        Uses binary search for O(log N) lookup.
        
        Args:
            key: Data key to locate
            
        Returns:
            Node ID responsible for this key
            
        Raises:
            ValueError: If hash ring is empty
        """
        if not self._ring:
            raise ValueError("No nodes in hash ring")
        
        hash_key = self._hash(key)
        
        # Binary search for the first node >= hash_key
        left, right = 0, len(self._sorted_keys)
        
        while left < right:
            mid = (left + right) // 2
            if self._sorted_keys[mid] < hash_key:
                left = mid + 1
            else:
                right = mid
        
        # If we didn't find any node >= hash_key, wrap around to first node
        index = left if left < len(self._sorted_keys) else 0
        return self._ring[self._sorted_keys[index]]
    
    def get_nodes(self, key: str, count: int = 3) -> list[str]:
        """
        Get N responsible nodes for a key (for replication).
        
        Returns unique nodes in consistent order.
        
        Args:
            key: Data key
            count: Number of nodes to return
            
        Returns:
            List of node IDs
        """
        if not self._ring:
            return []
        
        nodes = []
        seen = set()
        hash_key = self._hash(key)
        
        # Find the starting position
        left, right = 0, len(self._sorted_keys)
        while left < right:
            mid = (left + right) // 2
            if self._sorted_keys[mid] < hash_key:
                left = mid + 1
            else:
                right = mid
        
        # Walk the ring, collecting unique nodes
        start_index = left if left < len(self._sorted_keys) else 0
        for i in range(len(self._sorted_keys)):
            index = (start_index + i) % len(self._sorted_keys)
            node = self._ring[self._sorted_keys[index]]
            
            if node not in seen:
                nodes.append(node)
                seen.add(node)
                
                if len(nodes) >= count:
                    break
        
        return nodes
    
    @staticmethod
    def _hash(key: str) -> int:
        """
        Compute hash value for a key.
        
        Uses MD5 for speed and distribution.
        In production, consider SHA-256 for cryptographic needs.
        """
        return int(hashlib.md5(key.encode()).hexdigest(), 16)
    
    def get_stats(self) -> dict[str, int]:
        """Get statistics about the hash ring."""
        node_ids = set(self._ring.values())
        return {
            "num_nodes": len(node_ids),
            "num_virtual_nodes": len(self._ring),
            "replicas_per_node": self.replicas,
        }


class ShardRouter:
    """
    Routes requests to shards using consistent hashing.
    
    Provides:
    - Shard ID lookup from data key
    - Shard prefix generation for storage collections
    - Replication node selection
    
    Usage:
        router = ShardRouter(num_shards=16)
        shard_id = router.get_shard_id("user_123")
        collection_name = f"users_shard_{shard_id}"
    """
    
    def __init__(self, num_shards: int = 16, replicas: int = 3):
        """
        Initialize shard router.
        
        Args:
            num_shards: Number of shards (typically power of 2)
            replicas: Number of replica nodes per shard
        """
        if num_shards < 1 or num_shards > 1024:
            raise ValueError("num_shards must be between 1 and 1024")
        
        self.num_shards = num_shards
        self.replicas = replicas
        self._hash = ConsistentHash(replicas=replicas)
        
        # Initialize shard nodes
        for i in range(num_shards):
            self._hash.add_node(f"shard_{i}")
    
    def get_shard_id(self, key: str) -> int:
        """
        Get shard ID for a key.
        
        Args:
            key: Data key
            
        Returns:
            Shard ID (0 to num_shards-1)
        """
        node = self._hash.get_node(key)
        shard_num = int(node.split("_")[1])
        return shard_num
    
    def get_shard_key(self, key: str) -> str:
        """
        Get the shard key for storage.
        
        Args:
            key: Data key
            
        Returns:
            Shard prefix for database collection name
            
        Example:
            key = "user_123"
            shard_key = "shard_4"  # Assumes user_123 hashes to shard 4
        """
        shard_id = self.get_shard_id(key)
        return f"shard_{shard_id}"
    
    def get_shard_collection(self, base_name: str, key: str) -> str:
        """
        Get the full collection name for a shard.
        
        Args:
            base_name: Base collection name (e.g., "users", "rate_limits")
            key: Data key for shard selection
            
        Returns:
            Full collection name with shard suffix
            
        Example:
            base_name = "rate_limits"
            key = "user_123:api_calls:2026-08-30"
            returns "rate_limits_shard_4"
        """
        shard_key = self.get_shard_key(key)
        return f"{base_name}_{shard_key}"
    
    def get_replica_shards(self, key: str) -> list[int]:
        """
        Get replica shard IDs for replication.
        
        Args:
            key: Data key
            
        Returns:
            List of shard IDs for replication
        """
        replicas = self._hash.get_nodes(key, self.replicas)
        return [int(r.split("_")[1]) for r in replicas]
    
    def add_shard(self) -> None:
        """Add a new shard (for scaling up)."""
        new_shard_id = self.num_shards
        self._hash.add_node(f"shard_{new_shard_id}")
        self.num_shards += 1
        logger.info(f"Added new shard: shard_{new_shard_id}")
    
    def get_stats(self) -> dict[str, int]:
        """Get router statistics."""
        return {
            "num_shards": self.num_shards,
            "replicas_per_shard": self.replicas,
            **self._hash.get_stats()
        }


class ShardKeyGenerator:
    """
    Utility for generating optimal shard keys.
    
    Best practices:
    - Use user_id for user data
    - Use request_id for idempotency
    - Use (user_id + timestamp) for time-series
    """
    
    @staticmethod
    def for_user(user_id: str) -> str:
        """Generate shard key for user data."""
        if not user_id:
            raise ValueError("user_id cannot be empty")
        return user_id
    
    @staticmethod
    def for_request(request_id: str) -> str:
        """Generate shard key for request tracking."""
        if not request_id:
            raise ValueError("request_id cannot be empty")
        return request_id
    
    @staticmethod
    def for_time_series(user_id: str, timestamp: str) -> str:
        """Generate shard key for time-series data."""
        if not user_id or not timestamp:
            raise ValueError("user_id and timestamp cannot be empty")
        return f"{user_id}:{timestamp[:10]}"  # Shard by user + date
    
    @staticmethod
    def for_composite(parts: Sequence[str]) -> str:
        """Generate shard key from multiple parts."""
        if not parts or any(not p for p in parts):
            raise ValueError("All parts must be non-empty")
        return ":".join(parts)

