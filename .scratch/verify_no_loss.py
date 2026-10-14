"""Did the migration weaken the suite? Count the things that matter, per file.

Test declarations and assertions are counted in the HEAD version and in the
working copy. A migration that adds `await` must not change either number -- and
a script that rewrites lines by index can quietly lose a line, so this is worth
checking rather than assuming.
"""

import subprocess

NL = chr(10)

files = subprocess.run(
    ["git", "diff", "--name-only", "--", "platform/"],
    capture_output=True, text=True, check=True).stdout.split()

problems = 0
for name in files:
    if not name.endswith(".test.ts"):
        continue
    head = subprocess.run(["git", "show", "HEAD:" + name], capture_output=True, text=True).stdout
    current = open(name, encoding="utf-8").read()
    for label, needle in [("tests", "test("), ("asserts", "assert.")]:
        before = head.count(needle)
        after = current.count(needle)
        if before != after:
            problems += 1
            print("MISMATCH", name, label, "HEAD=", before, "now=", after)

print("files compared:", len([f for f in files if f.endswith('.test.ts')]))
print("mismatches:", problems)