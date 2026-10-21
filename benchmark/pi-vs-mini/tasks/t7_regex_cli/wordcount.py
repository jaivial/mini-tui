#!/usr/bin/env python3
"""TODO: wordcount CLI. Usage: wordcount.py [--top N] FILE"""
import argparse, sys
from collections import Counter

def count_words(text):
    # TODO: implement - lowercase, split on non-alphanumeric runs, drop empties
    raise NotImplementedError

def main(argv=None):
    p = argparse.ArgumentParser(prog="wordcount")
    # TODO: add --top N (default 10) and a positional FILE
    raise NotImplementedError
    return 0

if __name__ == "__main__":
    sys.exit(main())
