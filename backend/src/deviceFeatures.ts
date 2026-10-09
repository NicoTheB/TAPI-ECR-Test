// Device feature templates sourced from the supplied Worldline Terminal API OpenAPI examples.
// Header, webhook and terminal Environment are added server-side for each operation.
export type DeviceFeatureTemplate = {
  id: string;
  label: string;
  description: string;
  deviceRequest: Record<string, unknown>;
};

export const deviceFeatureTemplates: DeviceFeatureTemplate[] = [
  {
    "id": "UIInfoRequest",
    "label": "UI info screen",
    "description": "Show an informational message with two buttons and wait for the terminal response.",
    "deviceRequest": {
      "InputRequest": {
        "DisplayOutput": {
          "MessageContent": {
            "InfoScreen": {
              "Title": "Do you want to redeem your loyalty card?",
              "Subtitle": "You currently have enough point for a 2.50 EUR discount",
              "Text": "This will apply the discount to your current transaction",
              "PrimaryButton": {
                "ButtonId": "first_button",
                "ButtonContent": "Yes"
              },
              "SecondaryButton": {
                "ButtonId": "second_button",
                "ButtonContent": "No"
              }
            }
          }
        },
        "InputData": {
          "MaximumInputTime": 30000
        }
      }
    }
  },
  {
    "id": "UIScreenProcessingRequest",
    "label": "UI processing screen",
    "description": "Show an informational processing screen while waiting for an input response.",
    "deviceRequest": {
      "InputRequest": {
        "DisplayOutput": {
          "MessageContent": {
            "InfoScreen": {
              "Title": "Confirming your loyalty discount",
              "Subtitle": "A 2.50 EUR discount will be applied",
              "Text": "Please continue to complete your payment",
              "PrimaryButton": {
                "ButtonId": "first_button",
                "ButtonContent": "Continue"
              },
              "SecondaryButton": {
                "ButtonId": "second_button",
                "ButtonContent": "Cancel"
              }
            }
          }
        },
        "InputData": {
          "MaximumInputTime": 30000,
          "ShowProcessingScreen": true
        }
      }
    }
  },
  {
    "id": "UICaptureDataRequest",
    "label": "Capture data screen",
    "description": "Ask the customer to enter configured text data such as an email address.",
    "deviceRequest": {
      "InputRequest": {
        "DisplayOutput": {
          "MessageContent": {
            "CaptureDataScreen": {
              "Title": "Please enter your email",
              "CapturingDataType": "EMAIL",
              "PrimaryButton": {
                "ButtonId": "first_button",
                "ButtonContent": "Submit"
              },
              "SecondaryButton": {
                "ButtonId": "second_button",
                "ButtonContent": "Close"
              }
            }
          }
        },
        "InputData": {
          "MaximumInputTime": 30000
        }
      }
    }
  },
  {
    "id": "UISingleSelectionRequest",
    "label": "Single selection screen",
    "description": "Show a single-choice selection list on the terminal.",
    "deviceRequest": {
      "InputRequest": {
        "DisplayOutput": {
          "MessageContent": {
            "MultiOptionsSingleSelectionScreen": {
              "Title": "Icon System Demonstration",
              "OptionElements": [
                {
                  "OptionId": "option1",
                  "OptionTitle": "Custom WL Icon",
                  "OptionContent": "icon.ic_yes",
                  "OptionIcon": "icon.ic_yes"
                },
                {
                  "OptionId": "option2",
                  "OptionTitle": "Direct Emoji",
                  "OptionContent": "emoji.🎉",
                  "OptionIcon": "emoji.🎉"
                },
                {
                  "OptionId": "option3",
                  "OptionTitle": "Unicode Emoji",
                  "OptionContent": "emoji.U+1F680",
                  "OptionIcon": "emoji.U+1F680"
                },
                {
                  "OptionId": "option4",
                  "OptionTitle": "Material Symbol",
                  "OptionContent": "material.celebration",
                  "OptionIcon": "material.celebration"
                },
                {
                  "OptionId": "option5",
                  "OptionTitle": "No Icon",
                  "OptionContent": "(no icon specified)"
                }
              ]
            }
          }
        },
        "InputData": {
          "MaximumInputTime": 30000
        }
      }
    }
  },
  {
    "id": "UIMultiSelectionRequest",
    "label": "Multiple selection screen",
    "description": "Show a multiple-choice selection list on the terminal.",
    "deviceRequest": {
      "InputRequest": {
        "DisplayOutput": {
          "MessageContent": {
            "MultiOptionsMultiSelectionScreen": {
              "Title": "How was our service?",
              "OptionElements": [
                {
                  "OptionId": "option1",
                  "OptionTitle": "Excellent",
                  "OptionIcon": "icon.ic_cloud"
                },
                {
                  "OptionId": "option2",
                  "OptionTitle": "Good",
                  "OptionIcon": "icon.ic_cloud"
                },
                {
                  "OptionId": "option3",
                  "OptionTitle": "Okay",
                  "OptionIcon": "icon.ic_cloud"
                },
                {
                  "OptionId": "option4",
                  "OptionTitle": "Bad",
                  "OptionIcon": "icon.ic_cloud"
                },
                {
                  "OptionId": "option5",
                  "OptionTitle": "Really Bad",
                  "OptionIcon": "icon.ic_cloud"
                }
              ],
              "PrimaryButton": {
                "ButtonId": "first_button",
                "ButtonContent": "Submit review"
              },
              "SecondaryButton": {
                "ButtonId": "second_button",
                "ButtonContent": "Return to Home"
              }
            }
          }
        },
        "InputData": {
          "MaximumInputTime": 0
        }
      }
    }
  },
  {
    "id": "UIQRRequest",
    "label": "QR code screen",
    "description": "Display a QR code with supporting text and a close button.",
    "deviceRequest": {
      "InputRequest": {
        "DisplayOutput": {
          "MessageContent": {
            "QRScreen": {
              "Title": "Scan",
              "Subtitle": "Join our loyalty program",
              "Text": "Thank you",
              "QRCode": "https://loyalty.example.com/join",
              "PrimaryButton": {
                "ButtonId": "first_button",
                "ButtonContent": "Close"
              }
            }
          }
        },
        "InputData": {
          "MaximumInputTime": 0
        }
      }
    }
  },
  {
    "id": "UIImageRequest",
    "label": "Image screen",
    "description": "Display an image on a compatible terminal. The example includes an image payload.",
    "deviceRequest": {
      "InputRequest": {
        "DisplayOutput": {
          "MessageContent": {
            "ImageScreen": {
              "ButtonColor": "#3700B3",
              "ImageBase64": "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\n",
              "PrimaryButton": {
                "ButtonId": "first_button",
                "ButtonContent": "Continue"
              },
              "SecondaryButton": {
                "ButtonId": "second_button",
                "ButtonContent": "Close"
              }
            }
          }
        },
        "InputData": {
          "MaximumInputTime": 30000
        }
      }
    }
  },
  {
    "id": "UIImageInfoRequest",
    "label": "Image/info screen",
    "description": "Display an information screen with icon and buttons.",
    "deviceRequest": {
      "InputRequest": {
        "DisplayOutput": {
          "MessageContent": {
            "ImageInfoScreen": {
              "Title": "Transaction Successful!",
              "Subtitle": "Amount Charged: 5,00 EUR",
              "Text": "Thank you for charging with us",
              "Icon": "icon.ic_yes",
              "PrimaryButton": {
                "ButtonId": "first_button",
                "ButtonContent": "Print Receipt"
              },
              "SecondaryButton": {
                "ButtonId": "second_button",
                "ButtonContent": "Close"
              }
            }
          }
        },
        "InputData": {
          "MaximumInputTime": 0
        }
      }
    }
  },
  {
    "id": "UIImageInfoCustomColorsRequest",
    "label": "Image/info screen — custom colors",
    "description": "Display an information screen using custom colors and icon.",
    "deviceRequest": {
      "InputRequest": {
        "DisplayOutput": {
          "MessageContent": {
            "ImageInfoScreen": {
              "ShowLogo": false,
              "Title": "Custom Colors Test",
              "Subtitle": "This screen has custom background and button colors with smart text contrast",
              "BackgroundColor": "#FF6B35",
              "ButtonColor": "#FFD23F",
              "Icon": "material.house",
              "IconColor": "#FF6B35",
              "Text": "You can also change the material icons color",
              "PrimaryButton": {
                "ButtonId": "confirm_button",
                "ButtonContent": "Confirm"
              },
              "SecondaryButton": {
                "ButtonId": "cancel_button",
                "ButtonContent": "Cancel"
              }
            }
          }
        },
        "InputData": {
          "MaximumInputTime": 30000
        }
      }
    }
  },
  {
    "id": "UISignatureRequest",
    "label": "Signature screen",
    "description": "Request a signature/input on a compatible terminal.",
    "deviceRequest": {
      "InputRequest": {
        "DisplayOutput": {
          "MessageContent": {
            "SignatureScreen": {
              "Title": "Please sign",
              "PrimaryButton": {
                "ButtonId": "first_button",
                "ButtonContent": "Confirm"
              },
              "SecondaryButton": {
                "ButtonId": "second_button",
                "ButtonContent": "Close"
              }
            }
          }
        },
        "InputData": {
          "MaximumInputTime": 100000
        }
      }
    }
  },
  {
    "id": "UITableRequest",
    "label": "Table/info screen",
    "description": "Display an information table on a compatible terminal.",
    "deviceRequest": {
      "InputRequest": {
        "DisplayOutput": {
          "MessageContent": {
            "InfoTableScreen": {
              "Title": "Pricing",
              "FormattedString": "Long formatted receipt...",
              "PrimaryButton": {
                "ButtonId": "first_button",
                "ButtonContent": "Close"
              }
            }
          }
        },
        "InputData": {
          "MaximumInputTime": 100000
        }
      }
    }
  },
  {
    "id": "UICaptureRatingScreenRequest",
    "label": "Rating screen",
    "description": "Display a rating selection prompt.",
    "deviceRequest": {
      "InputRequest": {
        "DisplayOutput": {
          "MessageContent": {
            "MultiOptionsSingleSelectionScreen": {
              "Title": "How was your experience with us?",
              "OptionElements": [
                {
                  "OptionId": "option1",
                  "OptionTitle": "Excellent",
                  "OptionIcon": "icon.ic_smiley_satisfied"
                },
                {
                  "OptionId": "option2",
                  "OptionTitle": "Okay",
                  "OptionIcon": "icon.ic_smiley_medium"
                },
                {
                  "OptionId": "option3",
                  "OptionTitle": "Bad",
                  "OptionIcon": "icon.ic_smiley_dissatisfied"
                }
              ]
            }
          }
        },
        "InputData": {
          "MaximumInputTime": 30000
        }
      }
    }
  },
  {
    "id": "PrintSimpleTextRequest",
    "label": "Print simple text",
    "description": "Print a simple text receipt/message.",
    "deviceRequest": {
      "PrintRequest": {
        "OutputContent": {
          "Format": "SimpleText",
          "MessageContent": "Hello World - Simple Print Test"
        }
      }
    }
  },
  {
    "id": "PrintQRCodeRequest",
    "label": "Print QR code",
    "description": "Print a QR code barcode.",
    "deviceRequest": {
      "PrintRequest": {
        "OutputContent": {
          "Format": "Barcode",
          "OutputBarcode": {
            "BarcodeType": "QRCode",
            "BarcodeValue": "https://example.com/receipt/12345"
          }
        }
      }
    }
  },
  {
    "id": "PrintImageRequest",
    "label": "Print image",
    "description": "Print an image on a compatible printer.",
    "deviceRequest": {
      "PrintRequest": {
        "OutputContent": {
          "Format": "Image",
          "OutputImage": {
            "ImageBase64": "iVBORw0KGgoAAAANSUhEUgAAAYAAAAA/AQAAAADBVyIGAAACZ0lEQVR42u2WMW7cMBBFH2nBZhWoTGHAPILLlDxSynSeDVKk9BF8FCKVS58g0AILBOlkIwXl0GQKipS0dpMqCLBT7FKr+Zo/fz6pVZm/C80JcAL8c8BegVIA7JS8SnyUCsiaMGTNHQ4w7AC+MsFhsmRRygKMPrtW4aeDLDwAsTxnogMYlwo9aQEwQoJfwMt8X9rnVR6AZzNEKQCVAXSEtGRyB8CHVuBHN66aHkgEyAAejsgAMAhTdmuVjjICAJft2n4LTytZAwwXESHLAHAz13m39Kw4pLmCFNrvz/Dgyv3ruC2YzBCJslCKnbcIYMu1SQBcVMBvRrmftpN2uKFddBt1IXwpGs4AX27ZV47pmiQ6uNunFwENzhNXDytRDkTta8+ebA9rSmYrrToag9lHi4nSAKHY5ThU62oUnJ9qBVUpwLBFfGwipJ7+qQDsIJWEqs5YxV458ufg5i41gE611Sx2k13d58l4e1iaHvu3d+wlXGVP2kdrMvdhlZHb/N4MARwRNPQjsui4HUd135j49J3bsVTI8+PHHs54Y37o4HoQDjOlbrFFtyVoVuCY7dLlAMKwHAKVYlcYqpjxwD1oMAEH4lnlp+OmrRkfcf1WR29bZpx/n903CnIeEouXBPeAgM7rLd3MFFJhbQvg2eAd4QWHQhDgttsycn03S6GrMHbq5hnsOnZitu7L89FVKVnoizLi68m45hZtcaVbNW3Kuu5ru3HKgEGhEtIA0hVu9shSl01l0+yp6ctitU2VzO+KxF71s8UCN5VSD0q4BvpC+ryOsK9furmmxrgsZVm+CnX6g3UC/DeAP/KQB/YlnYccAAAAAElFTkSuQmCC",
            "ImageWidth": 384,
            "ImageHeight": 63
          }
        }
      }
    }
  },
  {
    "id": "PrintJSONReceiptRequest",
    "label": "Print JSON receipt",
    "description": "Print structured lines using Worldline JSON receipt format.",
    "deviceRequest": {
      "PrintRequest": {
        "OutputContent": {
          "Format": "JSON",
          "OutputJSON": [
            {
              "CharacterStyle": "Bold",
              "Alignment": "Centred",
              "EndOfLineFlag": true,
              "Text": "STORE NAME"
            },
            {
              "CharacterStyle": "Normal",
              "Alignment": "Left",
              "EndOfLineFlag": false,
              "Text": "Item 1"
            },
            {
              "CharacterStyle": "Normal",
              "Alignment": "Right",
              "EndOfLineFlag": true,
              "Text": "EUR 5.00"
            }
          ]
        }
      }
    }
  },
  {
    "id": "PrintMultiFormatRequest",
    "label": "Print multi-format receipt",
    "description": "Print a combination of text, structured JSON, and barcode formats.",
    "deviceRequest": {
      "PrintRequest": {
        "OutputContent": {
          "Format": "SimpleText",
          "MessageContent": "--- Header ---"
        },
        "OutputContentList": [
          {
            "OutputContent": {
              "Format": "JSON",
              "OutputJSON": [
                {
                  "CharacterStyle": "Bold",
                  "Alignment": "Centred",
                  "EndOfLineFlag": true,
                  "Text": "STORE NAME"
                }
              ]
            }
          },
          {
            "OutputContent": {
              "Format": "Barcode",
              "OutputBarcode": {
                "BarcodeType": "QRCode",
                "BarcodeValue": "https://example.com/receipt/12345"
              }
            }
          },
          {
            "OutputContent": {
              "Format": "SimpleText",
              "MessageContent": "    Thank you for visiting!"
            }
          }
        ]
      }
    }
  }
];
