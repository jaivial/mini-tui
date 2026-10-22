from scheduler import best_schedule

names = lambda js: [j["name"] for j in js]

jobs = [
    {"name": "a", "start": 0, "end": 3, "weight": 3},
    {"name": "b", "start": 2, "end": 5, "weight": 4},
    {"name": "c", "start": 4, "end": 7, "weight": 5},
    {"name": "d", "start": 6, "end": 9, "weight": 6},
]
assert names(best_schedule(jobs)) == ["b", "d"], "b+d = 10 beats a+c = 8"
assert names(best_schedule([{"name": "x", "start": 0, "end": 1, "weight": 1}])) == ["x"]
assert best_schedule([]) == []
touch = [
    {"name": "p", "start": 0, "end": 2, "weight": 2},
    {"name": "q", "start": 2, "end": 4, "weight": 2},
]
assert names(best_schedule(touch)) == ["p", "q"], "touching intervals do not overlap"
print("part7 scheduler PASS")
