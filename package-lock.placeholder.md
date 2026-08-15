# Lockfile note

The execution environment used to generate this scaffold has no package-registry network access, so a trustworthy `package-lock.json` could not be generated here.

On the first developer machine with registry access:

```bash
npm install
npm run check
git add package-lock.json
git commit -m "chore: lock workspace dependencies"
```

After that commit, CI should be changed from `npm install` to `npm ci`.
