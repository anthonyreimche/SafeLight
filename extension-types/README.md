# Extension API types

`safelight.d.ts` is Safelight's extension API as one self-contained declaration file. Extensions copy it into their own repo (the [extension template](../docs/dev/extensions/README.md#with-a-build) does) and typecheck against it. It needs only React's, React DOM's and zustand's types beside it.

It is generated from [`src/extensions/api/`](../src/extensions/api/). Don't edit it: change the API, then regenerate it.

```bash
npm run types:extensions          # rewrite safelight.d.ts
npm run types:extensions:check    # fail if it is out of date
```

The script, [`scripts/build-extension-types.mjs`](../scripts/build-extension-types.mjs), follows every name the API's exports use to its declaration, copies those declarations in, and keeps imports from packages as imports. It then compiles the result on its own and fails if anything is missing. Host functions the API mentions through `typeof` are declared but not exported, since an extension reaches them through `api`.
