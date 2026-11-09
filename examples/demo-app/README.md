# Demo app

A tiny Vite grocery list with a known bug: after you add an item, "Nothing on the list yet." stays on screen.

Try patchreplay on it:

```sh
cp -R examples/demo-app /tmp/pr-demo && cd /tmp/pr-demo
git init -q && npm install && git add -A && git commit -qm init
# ask your agent: "The empty-state message doesn't go away after I add an item. Fix it."
npx patchreplay run --open
```
