# Task: finish the wordcount CLI

`wordcount.py` is a skeleton with two `NotImplementedError`s. Implement it:

- `count_words(text)`: lowercases, splits on runs of non-alphanumeric characters,
  drops empty tokens.
- `main()`: argparse with a `--top N` option (default 10) and one positional
  `FILE`. Prints one `<word> <count>` line per word, most frequent first, ties
  alphabetical, at most N lines.

Example: given a file containing `The quick brown fox. The FOX jumps; the dog sleeps...\nfox fox FOX\n`
`--top 3` must print fox with count 3 first; the default must include `the` with
count 4. Exit code 0. Work only in the current directory; keep the file name.
