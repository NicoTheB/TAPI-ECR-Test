# Device feature inventory

These are the 17 Device operation examples loaded from the attached Worldline OpenAPI document. The backend rebuilds request headers and adds the terminal environment at send time.

| Feature ID | Frontend label | Request content |
|---|---|---|
| `UIInfoRequest` | UI info screen | `InputRequest` |
| `UIScreenProcessingRequest` | UI processing screen | `InputRequest` |
| `UICaptureDataRequest` | Capture data screen | `InputRequest` |
| `UISingleSelectionRequest` | Single selection screen | `InputRequest` |
| `UIMultiSelectionRequest` | Multiple selection screen | `InputRequest` |
| `UIQRRequest` | QR code screen | `InputRequest` |
| `UIImageRequest` | Image screen | `InputRequest` |
| `UIImageInfoRequest` | Image/info screen | `InputRequest` |
| `UIImageInfoCustomColorsRequest` | Image/info screen — custom colors | `InputRequest` |
| `UISignatureRequest` | Signature screen | `InputRequest` |
| `UITableRequest` | Table/info screen | `InputRequest` |
| `UICaptureRatingScreenRequest` | Rating screen | `InputRequest` |
| `PrintSimpleTextRequest` | Print simple text | `PrintRequest` |
| `PrintQRCodeRequest` | Print QR code | `PrintRequest` |
| `PrintImageRequest` | Print image | `PrintRequest` |
| `PrintJSONReceiptRequest` | Print JSON receipt | `PrintRequest` |
| `PrintMultiFormatRequest` | Print multi-format receipt | `PrintRequest` |

The `Device features` page provides an editable JSON editor for the inner `DeviceRequest` payload. The async response is delivered via the same authenticated per-operation webhook flow used by payment/device printing. Check that each terminal supports a feature before sending it; API acceptance is not a guarantee of terminal capability.
