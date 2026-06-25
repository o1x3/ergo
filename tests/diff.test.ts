import { describe, expect, test } from 'bun:test';

import { inferLanguage, looksGenerated, parseUnifiedDiff } from '@/git/diff';

describe('parseUnifiedDiff', () => {
  test('parses a simple modification with line numbers', () => {
    const raw = `diff --git a/src/foo.ts b/src/foo.ts
index 111..222 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,3 +1,4 @@
 const a = 1;
-const b = 2;
+const b = 3;
+const c = 4;
 const d = 5;
`;
    const files = parseUnifiedDiff(raw);
    expect(files.length).toBe(1);
    const f = files[0]!;
    expect(f.path).toBe('src/foo.ts');
    expect(f.status).toBe('modified');
    expect(f.additions).toBe(2);
    expect(f.deletions).toBe(1);
    expect(f.language).toBe('typescript');
    const adds = f.hunks[0]!.lines.filter((l) => l.type === 'add');
    expect(adds[0]!.newLine).toBe(2);
    expect(adds[1]!.newLine).toBe(3);
    const del = f.hunks[0]!.lines.find((l) => l.type === 'del');
    expect(del!.oldLine).toBe(2);
  });

  test('detects added files', () => {
    const raw = `diff --git a/new.py b/new.py
new file mode 100644
index 000..abc
--- /dev/null
+++ b/new.py
@@ -0,0 +1,2 @@
+print("hi")
+print("bye")
`;
    const files = parseUnifiedDiff(raw);
    expect(files[0]!.status).toBe('added');
    expect(files[0]!.additions).toBe(2);
    expect(files[0]!.language).toBe('python');
  });

  test('detects deleted files', () => {
    const raw = `diff --git a/old.go b/old.go
deleted file mode 100644
index abc..000
--- a/old.go
+++ /dev/null
@@ -1,1 +0,0 @@
-package main
`;
    const files = parseUnifiedDiff(raw);
    expect(files[0]!.status).toBe('deleted');
    expect(files[0]!.deletions).toBe(1);
  });

  test('detects renames', () => {
    const raw = `diff --git a/old/name.ts b/new/name.ts
similarity index 90%
rename from old/name.ts
rename to new/name.ts
index abc..def 100644
--- a/old/name.ts
+++ b/new/name.ts
@@ -1,1 +1,1 @@
-const x = 1;
+const x = 2;
`;
    const files = parseUnifiedDiff(raw);
    expect(files[0]!.status).toBe('renamed');
    expect(files[0]!.path).toBe('new/name.ts');
    expect(files[0]!.oldPath).toBe('old/name.ts');
  });

  test('detects binary files', () => {
    const raw = `diff --git a/img.png b/img.png
index abc..def 100644
Binary files a/img.png and b/img.png differ
`;
    const files = parseUnifiedDiff(raw);
    expect(files[0]!.binary).toBe(true);
  });

  test('handles multiple files', () => {
    const raw = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1 +1 @@
-a
+b
diff --git a/b.ts b/b.ts
--- a/b.ts
+++ b/b.ts
@@ -1 +1 @@
-c
+d
`;
    const files = parseUnifiedDiff(raw);
    expect(files.length).toBe(2);
    expect(files.map((f) => f.path)).toEqual(['a.ts', 'b.ts']);
  });

  test('empty diff yields no files', () => {
    expect(parseUnifiedDiff('')).toEqual([]);
    expect(parseUnifiedDiff('   \n  ')).toEqual([]);
  });
});

describe('inferLanguage', () => {
  test('maps common extensions', () => {
    expect(inferLanguage('a/b/c.ts')).toBe('typescript');
    expect(inferLanguage('x.py')).toBe('python');
    expect(inferLanguage('Dockerfile')).toBe('dockerfile');
    expect(inferLanguage('Makefile')).toBe('makefile');
    expect(inferLanguage('weird.xyz')).toBe('xyz');
  });
});

describe('looksGenerated', () => {
  test('flags lockfiles and build artifacts', () => {
    expect(looksGenerated('bun.lock')).toBe(true);
    expect(looksGenerated('package-lock.json')).toBe(true);
    expect(looksGenerated('dist/index.js')).toBe(true);
    expect(looksGenerated('src/index.ts')).toBe(false);
  });
});
