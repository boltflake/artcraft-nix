"""The file-list checks: <pkg>-files (a package has exactly the files its
entry declares) and `aggregate` (no two packages in `default` declare the
same path, by buildEnv's merge rules). A pattern's `*` matches within one
path component, and a last component `**` matches one or more components.
Standard library only.

  files.py files OUT PATTERNS.json
  files.py aggregate DECLARED.json      ({package: [pattern, ...]})
"""
import fnmatch, json, os, sys


def matches(path, pattern):
    p, q = path.split("/"), pattern.split("/")
    if q[-1] == "**":
        q = q[:-1]
        return len(p) > len(q) and all(fnmatch.fnmatchcase(a, b) for a, b in zip(p, q))
    return len(p) == len(q) and all(fnmatch.fnmatchcase(a, b) for a, b in zip(p, q))


def files(out, patterns):
    found = []
    for root, dirs, names in os.walk(out):
        for n in names + [d for d in dirs if os.path.islink(os.path.join(root, d))]:
            found.append(os.path.relpath(os.path.join(root, n), out))
    empty = [os.path.relpath(root, out) for root, dirs, names in os.walk(out) if not dirs and not names and root != out]
    problems = [f"{d}/: an empty folder, which nothing declares" for d in sorted(empty)]
    problems += [f"{f}: not declared" for f in sorted(found) if not any(matches(f, p) for p in patterns)]
    problems += [f"{p}: declared, but the package has no such file" for p in patterns if not any(matches(f, p) for f in found)]
    for p in problems:
        print(p)
    print(f"{len(found)} files, {len(patterns)} patterns")
    return not problems


def could_meet(a, b):
    """Whether two components (globs) can name the same thing."""
    if "*" not in a and "*" not in b:
        return a == b
    if "*" not in b:
        return fnmatch.fnmatchcase(b, a)
    if "*" not in a:
        return fnmatch.fnmatchcase(a, b)
    # Both globs: they can meet unless their fixed starts or ends differ.
    pa, pb = a.split("*")[0], b.split("*")[0]
    sa, sb = a.split("*")[-1], b.split("*")[-1]
    return (pa.startswith(pb) or pb.startswith(pa)) and (sa.endswith(sb) or sb.endswith(sa))


def collide(a, b):
    """A file at `a` and one at `b` collide when they can be the same path,
    or one can be a directory the other needs (buildEnv merges shared
    directories, but not a file with a directory or two files)."""
    pa, pb = a.split("/"), b.split("/")
    # Past a `**`, anything can follow.
    pa = pa[:-1] if pa[-1] == "**" else pa
    pb = pb[:-1] if pb[-1] == "**" else pb
    n = min(len(pa), len(pb))
    return all(could_meet(x, y) for x, y in zip(pa[:n], pb[:n]))


def aggregate(declared):
    bad = []
    names = sorted(declared)
    for i, x in enumerate(names):
        for y in names[i + 1:]:
            for a in declared[x]:
                for b in declared[y]:
                    if collide(a, b):
                        bad.append(f"{x} {a} and {y} {b} can collide")
    for b in bad:
        print(b)
    print(f"{len(names)} packages compared")
    return not bad


if __name__ == "__main__":
    if sys.argv[1] == "files":
        ok = files(sys.argv[2], json.load(open(sys.argv[3])))
    elif sys.argv[1] == "aggregate":
        ok = aggregate(json.load(open(sys.argv[2])))
    else:
        sys.exit(__doc__)
    sys.exit(0 if ok else 1)
