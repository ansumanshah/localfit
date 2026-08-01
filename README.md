# localfit

Every in-browser AI integration ships a hardcoded guess. You pick a model and a quant, and every visitor gets the same file: the M3 Max gets the small build it didn't need, the 8 GB laptop chokes on one it can't hold, and nobody knew the download was 1.3 GB until users asked why the tab froze.

localfit replaces the guess. Given a model id, it answers three questions before anything downloads:

1. Can this browser run it?
2. Over WebGPU or WASM?
3. Exactly how many bytes is the download?

It never runs inference and it never wraps a runtime. It is the lookup step before you hand a model id to Transformers.js, WebLLM, or wllama. Think caniuse, as a function call.

Zero runtime dependencies. The decision logic is under 5 KB min+gzip; the bundled model data is separate and larger.

## Quickstart

```ts
import { pipeline } from "@huggingface/transformers";
import { fit } from "localfit";

const plan = await fit("gemma-3-1b-it");
// {
//   verdict: "yes",
//   backend: "webgpu",
//   dtype: "q4f16",
//   downloadBytes: 763529245,
//   model: "onnx-community/gemma-3-1b-it-ONNX",
//   reasons: [
//     "The 728 MB download fits within the per-tab JS heap limit (performance.memory.jsHeapSizeLimit) (4.0 GB).",
//   ],
//   config: { device: "webgpu", dtype: "q4f16" },
// }

if (plan.verdict !== "no") {
  const generator = await pipeline("text-generation", plan.model, plan.config);
}
```

`fit()` probes once per page load: WebGPU adapter, shader-f16, buffer limits, WASM SIMD and threads, memory signals, the iPadOS-pretending-to-be-a-Mac quirk. No network request, no download.

## Verdicts

| Verdict     | Meaning                                                                                                         |
| ----------- | --------------------------------------------------------------------------------------------------------------- |
| `"yes"`     | The chosen build fits comfortably within the best available memory signal. Nothing more.                        |
| `"tight"`   | The download is over 60% of the best available memory signal. It may load slowly or fail.                       |
| `"no"`      | A hard fact rules it out: a WebGPU-only runtime with no WebGPU, or no build published for the resolved backend. |
| `"unknown"` | The signal needed to decide is `null` (usually no memory signal at all, or an unrecognized model id).           |

`"yes"` means the weights can load. It says nothing about speed. localfit never estimates tokens per second and never labels a device fast or slow; if you need throughput, benchmark on the real device.

Every plan carries `reasons: string[]`, one sentence per decision made: why this backend, this variant, this verdict. One caveat worth knowing: `navigator.deviceMemory` is spec-capped at 8 for fingerprinting resistance, so a reported 8 means "8 GB or more", and `reasons` says so whenever a verdict leans on a capped reading.

## The data

`src/data/snapshot.json` is a stamped, slimmed copy of the [localmodel.run](https://localmodel.run) browser catalog: WebGPU and WASM build sizes summed from each model's actual Hugging Face file tree, byte-exact, never derived from a parameter count. The snapshot keeps only the fields the library reads (about a third smaller in your bundle than the raw catalog); each entry's `hf_repo` is its primary source (`https://huggingface.co/<hf_repo>`), the snapshot records the exact source commit it was synced at, and the full per-entry `sources[]` citations live in the catalog and arrive with `refresh()`.

`refresh()` pulls the current catalog from [`localmodel.run/api/browser-models.json`](https://localmodel.run/api/browser-models.json) at runtime and merges it in by model id. On any fetch failure or malformed response it keeps the snapshot it already has. It never fetches unless you call it. To re-bundle a newer snapshot at build time, run `bun run sync-data` (fetches from GitHub and stamps the commit; pass a local checkout path to sync from disk instead). Fetched data is shape-validated only.

Hard rules the code holds to: no number is guessed, no speed is claimed, a signal that cannot be detected is `null` rather than a default, and nothing is fetched without being asked.

## With your runtime

localfit decides what to load; your runtime loads it.

Feeding Transformers.js directly, since `plan.config` is already shaped for `pipeline()`:

```ts
import { pipeline } from "@huggingface/transformers";
import { fit } from "localfit";

const plan = await fit("smollm2-135m-instruct");
if (plan.verdict !== "no") {
  const generator = await pipeline("text-generation", plan.model, plan.config);
}
```

Or picking the model before an AI SDK community provider touches it, with [`@built-in-ai/transformers-js`](https://www.npmjs.com/package/@built-in-ai/transformers-js):

```ts
import { transformersJS } from "@built-in-ai/transformers-js";
import { streamText } from "ai";
import { fit } from "localfit";

const plan = await fit("qwen2.5-0.5b-instruct");
if (plan.verdict !== "no") {
  const result = streamText({
    model: transformersJS(plan.model, { dtype: plan.dtype, device: plan.backend }),
    prompt: "Explain what localfit does in one sentence.",
  });
}
```

Neither of these is competition. They load models; localfit answers whether this download, on this browser, right now, is a good idea.

## API

### `probe(): Promise<Env>`

Detects browser capabilities without downloading anything. Cached per page load.

```ts
interface Env {
  webgpu: {
    supported: boolean; // navigator.gpu present AND requestAdapter() resolved non-null
    shaderF16: boolean | null; // null if WebGPU itself is unsupported
    maxBufferSize: number | null;
    maxStorageBufferBindingSize: number | null;
    adapterInfo: {
      vendor: string | null;
      architecture: string | null;
      device: string | null;
      description: string | null;
    } | null;
  };
  wasm: {
    simd: boolean; // always determinable
    threads: boolean; // crossOriginIsolated && SharedArrayBuffer
  };
  memory: {
    deviceMemoryGb: number | null; // navigator.deviceMemory, Chromium-only, spec-capped at 8
    jsHeapSizeLimitBytes: number | null; // performance.memory.jsHeapSizeLimit, Chromium-only
  };
  platform: {
    isIOS: boolean; // includes the iPadOS-as-"MacIntel" quirk
    isSecureContext: boolean;
  };
}
```

`platform.isIOS` and `platform.isSecureContext` are informational: `fit()` reads `webgpu`, `wasm`, and `memory`, never `platform`. They exist for callers who need to branch on them, like warning about a non-secure origin before WebGPU init.

### `fit(modelId: string, opts?: FitOptions): Promise<FitPlan>`

```ts
interface FitOptions {
  env?: Env; // skip probe() and use this instead
  runtime?: "transformers.js" | "wllama" | "webllm";
}

interface FitPlan {
  verdict: "yes" | "tight" | "no" | "unknown";
  backend: "webgpu" | "wasm";
  dtype: string;
  downloadBytes: number;
  model: string; // the model's hf_repo
  reasons: string[];
  config: Record<string, unknown>; // ready to spread into the chosen runtime's load call
}
```

`config` is fully specified only for `transformers.js` (`{ device, dtype }`). wllama and WebLLM have their own load-option shapes this package has not verified against a real integration yet, so for those `config` carries just `{ backend }` rather than an invented shape.

### `models(): ModelInfo[]` / `getModel(id: string): ModelInfo | undefined`

Read the current snapshot.

### `refresh(url?: string): Promise<void>`

Fetches `url` (default `DATA_URL`, the live localmodel.run endpoint) and merges valid entries into the snapshot by id. Keeps the current snapshot on any failure.

### `snapshotMeta(): SnapshotMeta`

When the bundled snapshot was synced and which localmodel.run commit it came from.

## Development

```
bun install
bun test           # unit tests, mocked browser globals
bun run build      # dist/ (esm) + type declarations
bun run size-check # gzip budget check for the decision-logic bundle
bun run check      # typecheck + lint + format check + tests
```

## License

MIT. See [LICENSE](./LICENSE).
