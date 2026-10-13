# Worldline cloud showroom ECR

React showroom register with a Node/TypeScript backend for the Worldline Terminal API v2. The backend uses bearer JWT authentication and Worldline's asynchronous Nexo model.

## Implemented in this starter

- Three cloud terminal profiles with PIN-protected UI configuration for UMID, UTID, and JWT; JWTs are write-only and never returned to the browser
- Async card payment, unreferenced refund, referenced reversal of a payment recorded in this backend session, Acquirer Reconciliation/day-end (also exposed as capture), and abort
- Completion webhook receiver at `/api/worldline/webhook`
- Browser and terminal receipt printing using Worldline SimpleText receipts converted to the JSON printer format with centered headings and left/right aligned columns
- Async Device feature console with editable OpenAPI example payloads for all 17 Device examples: UI prompts/screens, data capture, selections, QR, image, signature, table, rating and print formats
- Latest approved payment and receipt printing shown within Product register and Manual operations
- Product-register operation status and abort control shown directly beneath the cart checkout
- Tablet-first static-screen layout with independently scrollable catalog/cart lists and fixed-size checkout, latest-payment, and operation-status panels; latest payment and receipt printing appear beneath checkout in Product register and beneath the form in Manual operations
- Dark/light mode toggle, persisted in the browser
- JSON-formatted inbound and Worldline outbound API request/response metadata logs with ISO timestamps (payloads and credentials are intentionally omitted)
- Admin-PIN-protected JSON log export
- Manual payment/refund entry in major currency units, converted to minor units by the frontend
- Opt-in capture-result email with a formatted JSON attachment via Resend
- Existing product catalog/editor, guarded by `ADMIN_PIN`

**Not included yet:** other administrative controls, pre-authorisations, durable transaction storage, and JWT acquisition/refresh. Device examples are templates; terminal model, firmware, and configuration determine which features are supported. The JWT values are treated as supplied bearer tokens and are not refreshed by the app.

## Authentication / identifiers

Copy `.env.example` to `.env`. Populate the per-terminal variables once Worldline provides credentials:

- `TERMINAL_TERMINAL1_UMID`, `_UTID`, `_JWT`
- `TERMINAL_TERMINAL2_UMID`, `_UTID`, `_JWT`
- `TERMINAL_TERMINAL3_UMID`, `_UTID`, `_JWT`

Use actual JWTs only in local `.env` or Render environment settings—never commit them or put them in frontend code. `WORLDLINE_INTEGRATOR_ID` is already set to `239240630F36B979`. The integration base URL is the default; change `WORLDLINE_BASE_URL` to the production URL only when authorized. Optional `*_POI_ID` values populate the Nexo `Environment.POI` field; leave blank unless Worldline specifies a value.

A configured request contains Nexo protocol version `5.1-WL2.1.1`, the IntegratorId and ECR software identity, a unique exchange ID, and the callback URL. Product-cart totals are already in minor currency units. Manual amounts are entered in major units and converted to cents (×100) before being sent.

## Worldline Device feature console

Open **Device features** in the frontend to try all 17 Device examples in the supplied OpenAPI document. The backend serves the template payloads at `GET /api/device/features`; the browser edits only the inner Nexo `DeviceRequest` JSON. On send, the backend validates the feature ID, supplies the selected terminal's trusted `Environment`, and creates fresh Nexo Header, exchange ID and webhook callback values before posting asynchronously to `/device`. The operation completes when the matching webhook arrives.

The console includes all listed UI screen/input examples and print examples (SimpleText, QR/barcode, Image, JSON receipt and multi-format). Templates are starting points and can be edited in the JSON editor. The `UIImageRequest` and `PrintImageRequest` examples include OpenAPI sample base64 image data. Not every terminal supports every extension; a terminal/API rejection is shown in the operation result. Some requests wait for customer input on-device until their configured `MaximumInputTime` expires.

The existing receipt-reprint action remains a separate `print` operation; it converts its plain-text receipt to JSON printer lines.

## Configure terminal names in the frontend

Select **Terminal settings**, enter `ADMIN_PIN`, then edit each terminal's display name, selector label, UMID, UTID, API Key (JWT), Nexo `InitiatingParty` identifier, and optional POI identifier. The backend persists settings in `data/cloud-terminals.json` with owner-only permissions (0600 where supported). The JWT field is write-only: the backend never returns a token to the browser. Leave it blank to retain the current JWT, or use **Clear saved JWT** to remove it. The file is ignored by Git. On Render free, the filesystem is ephemeral, so UI-configured settings may be lost on restart/redeploy; use Render environment variables or persistent storage for reliable operation. Environment settings bootstrap values when no UI-saved settings exist.

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

Render's free instance can spin down when idle, and its local filesystem is ephemeral. UI-saved terminal credentials in `data/cloud-terminals.json` are lost if Render resets its filesystem. This starter stores active operations and completed receipt/reversal lookup records **in memory**; restarts, deploys, or spin-downs that restart the process lose that session's operation state/history. Reprints and reversal references therefore work only while the current backend process retains the original approved payment. Use a persistent database before relying on transaction lookup across restarts or using this for anything beyond a showroom/demo. Product catalog changes are also lost on a free ephemeral filesystem.

## Important transaction notes

- Reconciliation sends `SaleToPOIReconciliationRequest` to `/api/v2/merchants/{umid}/terminals/{utid}/reconciliation` with `ReconciliationType: AcquirerReconciliation`; the terminal may perform its day-end settlement. It is not a generic capture-all endpoint.
- One active operation at a time is allowed per physical terminal. An HTTP 200 from `/payments/abort` confirms delivery of the abort signal, not the terminal cancellation itself; wait for the original payment webhook to confirm `ResponseReason: Aborted` (or another final outcome). The abort request now uses the same full ECR software identity, IntegratorId, initiating-party ID, POI environment and protocol version as the payment request; it targets the original payment's `ExchangeIdentification`. A cloud request timeout is treated as an unknown result; do not retry it until reconciled.
- The OpenAPI spec provides no historical payment-by-receipt endpoint. The Latest payment panel returns the most recent completed payment attempt, including declines and cancellations. Only approved payments are saved in the session and assigned a local six-digit receipt ID for receipt lookup/reversal. It is not the terminal's printed receipt number.
- Refund requests are sent as unreferenced Nexo refunds because the current frontend asks for an amount but no original-payment selection. Acquirer/terminal configuration may reject unreferenced refunds.
- Reversal requires a payment previously approved and saved in the same backend session; the saved POI transaction identification is used as the original transaction reference.
- Worldline payment receipt content arrives as SimpleText. Terminal printing converts those lines to Worldline's JSON printer extension (`Format: JSON`, `OutputJSON`) to preserve headings and label/value alignment; no ESC/P bytes are used. Text entries are trimmed and limited to 32 characters per printer entry based on the integration printer error observed during testing.
- The free Render tier is not a suitable durable payment backend. This project is intended as a development/showroom integration and should not be exposed as an unauthenticated production point of sale.


## Structured API logs and theme

The backend writes one-line JSON records to stdout for incoming `/api/*` HTTP requests and responses and outbound Worldline requests, responses, and transport errors. Each record has an ISO-8601 `timestamp`, event name, request correlation ID where applicable, endpoint/method, status, and elapsed time. To include the outbound Worldline JSON request and response bodies, set `WORLDLINE_LOG_PAYLOADS=true` in a trusted local/Render environment and restart. It defaults to `false`. Authorization/JWT and callback-token fields (including tokens in WebhookUrl) are redacted, but the remaining payment/device payloads and receipt data may still be sensitive. Disable verbose logging after troubleshooting; exported logs are retained in memory with a 5,000-record / 15 MB limit. Never publish these logs or commit them to GitHub.

Use the header **Light mode / Dark mode** button to switch appearance. The preference is stored in that browser's local storage.


## Export logs, manual amounts, and capture-result email

In **Terminal settings**, unlock with `ADMIN_PIN` and choose **Download JSON logs**. The export contains the current backend process's structured logs (up to 5,000 records); it is session-memory only and resets when the process restarts. HTTP body contents, bearer headers, JWTs, callback tokens, and card/receipt content are not logged.

Manual payment/refund amounts are entered in major units, for example `12.34`; the frontend converts this to `1234` minor units before submission.

To opt in to emailing a capture/reconciliation result, enable the email checkbox on the Reconciliation form and enter the recipient. Configure `RESEND_API_KEY` and `CAPTURE_EMAIL_FROM` on the backend; the sender address/domain must be verified with Resend. Do not put these secrets in Git. The result is sent as a formatted JSON message and `.json` attachment after Worldline's final webhook arrives. The JSON email redacts callback tokens. Sending is optional and unconfigured email results in a clear request error rather than silently discarding the request.
