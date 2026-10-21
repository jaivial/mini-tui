# Task: top-5 words in a structured log

`logs/app.log` has 20000 lines with this format (single spaces):

    <date> <time> <LEVEL> worker-<N> <word> id=<I> value=<V>

Write `answer.json` in the current directory: a JSON object with a single key
`"top_words"`, a list of exactly 5 `[word, count]` pairs (word string, count int)
for the 5 most frequent `<word>` tokens (column 5), ordered by count descending.
Ties (if any) break alphabetically ascending. Do not include anything else in the
file. Work only in the current directory.
