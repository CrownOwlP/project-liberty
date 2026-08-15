# GitHub Setup

The scaffold was generated as a real local Git repository with `main` and an initial commit.

## Fastest publish path with GitHub CLI

From the repository root, after installing and authenticating `gh`:

```bash
gh auth login
gh repo create CrownOwlP/project-liberty --private --source=. --remote=origin --push
```

## If you create an empty repository in GitHub first

```bash
git remote add origin git@github.com:CrownOwlP/project-liberty.git
git push -u origin main
```

## Immediately after first publish

1. Run `npm install` on a machine with npm registry access.
2. Run `npm run check`.
3. Commit the generated `package-lock.json`.
4. Change CI install from `npm install --no-audit --no-fund` to `npm ci --no-audit --no-fund`.
5. Protect `main`: require pull requests and the CI status check.
6. Keep the repository private until content-provider licensing, secrets, and distribution strategy are intentionally decided.
