# Worldline cloud showroom ECR

React showroom register with a Node/TypeScript backend for the Worldline Terminal API v2. The backend uses bearer JWT authentication and Worldline's asynchronous Nexo model.

## Implemented in this starter

- Three backend-configured cloud terminal profiles (UMID, UTID, JWT are environment variables; the browser never receives JWTs)
- Async card payment, unreferenced refund, referenced reversal of a payment recorded in this backend session, Acquirer Reconciliation/day-end (also exposed as capture), and abort
- Completion webhook receiver at `/api/worldline/webhook`
- Browser and terminal receipt printing using Worldline SimpleText receipts converted to the JSON printer format with centered headings and left/right aligned columns
- Latest approved payment and lookup/reprint by a local six-digit showroom receipt number
- Existing product catalog/editor, guarded by `ADMIN_PIN`

**Not included yet:** other administrative/device controls beyond receipt printing and reconciliation, pre-authorisations, durable transaction storage, and JWT acquisition/refresh. The JWT values are treated as supplied bearer tokens and are not refreshed by the app.

## Authentication / identifiers

Copy `.env.example` to `.env`. Populate the per-terminal variables once Worldline provides credentials:

- `TERMINAL_TERMINAL1_UMID`, `_UTID`, `_JWT`
- `TERMINAL_TERMINAL2_UMID`, `_UTID`, `_JWT`
- `TERMINAL_TERMINAL3_UMID`, `_UTID`, `_JWT`

Use actual JWTs only in local `.env` or Render environment settings—never commit them or put them in frontend code. `WORLDLINE_INTEGRATOR_ID` is already set to `239240630F36B979`. The integration base URL is the default; change `WORLDLINE_BASE_URL` to the production URL only when authorized. Optional `*_POI_ID` values populate the Nexo `Environment.POI` field; leave blank unless Worldline specifies a value.

A configured request contains Nexo protocol version `5.1-WL2.1.1`, the IntegratorId and ECR software identity, a unique exchange ID, and the callback URL. Amounts from the frontend are minor currency units and the backend converts them using the catalog divisor (or `WORLDLINE_MINOR_UNIT_DIVISOR` for manual requests).

## Configure terminal names in the frontend

Select **Terminal settings**, enter `ADMIN_PIN`, then edit each configured terminal's display name, selector label, Nexo `InitiatingParty` identifier, and optional POI identifier. The backend persists these non-secret settings in `data/cloud-terminals.json`. The three terminal profiles and their UMID/UTID/JWT values remain controlled by environment variables; the browser never receives bearer tokens. On Render free, this settings file disappears when the instance filesystem resets.

## Async webhook behavior and webhook.site testing

The API's `202 Accepted` response is only an acknowledgement; the actual Nexo result arrives as a later POST to `Header.WebhookUrl`. This API document does not define a polling endpoint. The backend associates callbacks with an operation using a random operation ID and callback token in the webhook URL query string.

The provided `WORLDLINE_WEBHOOK_URL` is the requested webhook.site inbox. You **can use it to inspect callbacks during testing**, but webhook.site is not a relay to the backend. Therefore, with that URL the showroom will remain pending and keep the terminal locked after Worldline accepts the request. To complete the local UI test, copy the callback JSON from webhook.site and POST it to the locally running backend's `/api/worldline/webhook`, preserving the `operationId` and `callbackToken` query values from the callback URL shown in the webhook.site request. The token is a per-operation callback credential; don't share callback URLs publicly. Alternatively, configure a public HTTPS tunnel to your local backend and set `WORLDLINE_WEBHOOK_URL` to its `/api/worldline/webhook` endpoint.

When deployed, set `WORLDLINE_WEBHOOK_URL` in Render to:

```text
https://<your-render-service>.onrender.com/api/worldline/webhook
```

The backend appends operation and callback-token query parameters for each request. Once this is set, Worldline can post results directly to Render and the UI will update automatically.

## Run locally

Requirements: Node.js 20+ and npm.

```sh
cp .env.example .env
# Fill in real sandbox UMID/UTID/JWT values when provisioned.
npm install
npm run dev
```

Open <http://localhost:5173>. A terminal selector is available for all three profiles. With placeholders untouched, the UI loads but operation requests return a helpful missing-configuration error.

Build and run the combined app:

```sh
npm run build
npm start
```

## Render free web service

Create a **Web Service** from the repository. Use:

- Build command: `npm install && npm run build`
- Start command: `npm start`
- Environment: Node

Add all variables from `.env.example` to Render's Environment settings (do not upload `.env`). Replace the webhook base with your deployed Render callback URL only after the service URL exists. Keep integration/sandbox base URL until production credentials and terminal settings are authorized.

Render's free instance can spin down when idle, and its local filesystem is ephemeral. This starter stores active operations and completed receipt/reversal lookup records **in memory**; restarts, deploys, or spin-downs that restart the process lose that session's operation state/history. Reprints and reversal references therefore work only while the current backend process retains the original approved payment. Use a persistent database before relying on transaction lookup across restarts or using this for anything beyond a showroom/demo. Product catalog changes are also lost on a free ephemeral filesystem.

## Important transaction notes

- Reconciliation sends `SaleToPOIReconciliationRequest` to `/api/v2/merchants/{umid}/terminals/{utid}/reconciliation` with `ReconciliationType: AcquirerReconciliation`; the terminal may perform its day-end settlement. It is not a generic capture-all endpoint.
- One active operation at a time is allowed per physical terminal. An HTTP 200 from `/payments/abort` confirms delivery of the abort signal, not the terminal cancellation itself; wait for the original payment webhook to confirm `ResponseReason: Aborted` (or another final outcome). A cloud request timeout is treated as an unknown result; do not retry it until reconciled.
- The OpenAPI spec provides no historical payment-by-receipt endpoint. This backend saves successful payments in its own session and assigns a local six-digit receipt ID for lookup/reversal. It is not the terminal's printed receipt number.
- Refund requests are sent as unreferenced Nexo refunds because the current frontend asks for an amount but no original-payment selection. Acquirer/terminal configuration may reject unreferenced refunds.
- Reversal requires a payment previously approved and saved in the same backend session; the saved POI transaction identification is used as the original transaction reference.
- Worldline payment receipt content arrives as SimpleText. Terminal printing converts those lines to Worldline's JSON printer extension (`Format: JSON`, `OutputJSON`) to preserve headings and label/value alignment; no ESC/P bytes are used. Text entries are trimmed and limited to 32 characters per printer entry based on the integration printer error observed during testing.
- The free Render tier is not a suitable durable payment backend. This project is intended as a development/showroom integration and should not be exposed as an unauthenticated production point of sale.
