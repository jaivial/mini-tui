from tinydb import TinyDB

t = [1000.0]
db = TinyDB(lambda: t[0])
db.set("a", 1)
db.set("b", 2, ttl=10)
assert db.get("a") == 1
assert db.get("b") == 2
assert db.keys() == ["a", "b"]
t[0] = 1005.0
assert db.get("b") == 2
t[0] = 1011.0
assert db.get("b") is None, "expired keys read as None"
assert db.keys() == ["a"], "expired keys are gone on read"
assert db.delete("a") is True
assert db.delete("a") is False
db.set("c", 3, ttl=5)
db.set("d", 4)
t[0] = 1030.0
assert db.cleanup() == 1
assert db.keys() == ["d"]
print("part2 tinydb PASS")
