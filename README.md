# saleor-fixes

Small, focused scripts that detect and repair the everyday problems that hit real Saleor stores. Every fix ships in **both Python and Node.js**, is **safe by default** (a `DRY_RUN` flag that defaults to `true`, so it reports before it writes), and has a **pure decision function** with unit tests.

Each fix has a full write-up with diagrams on **[allanninal.dev/saleor](https://www.allanninal.dev/saleor/)**.

## How the scripts authenticate

The scripts talk to the Saleor **GraphQL API** at a single endpoint. Use an app token or a staff JWT:

```bash
export SALEOR_API_URL="https://your-store.saleor.cloud/graphql/"
export SALEOR_AUTH_TOKEN="your app or staff token"
export DRY_RUN="true"
```

They send `Authorization: Bearer <token>` and POST GraphQL queries and mutations.

## The fixes

| Fix | What it does | Type | Guide |
| --- | --- | --- | --- |
