import type {ParsedTrace} from '../../types'
import type {Persona} from '../types'

/**
 * "ML Engineer" persona. Interprets PyTorch Kineto / Chrome JSON traces
 * (the format `torch.profiler.profile().export_chrome_trace()` writes) the
 * way an ML engineer reading them wants to see them:
 *
 *   - colorize Python frames by *who wrote them* (user / framework /
 *     torch+stdlib) on top of the DevTools yellow scripting root,
 *   - call out GPU **kernels** (the actual on-device compute) in
 *     DevTools pink and demote memcpy/memset to a paler shade — kernels
 *     are what an ML engineer is hunting for,
 *   - bucket the CUDA runtime/driver call sites and profiler overhead
 *     into a neutral system gray so they don't drown out signal,
 *   - pin the `python (CPU)` process to the top, with `python (GPU N)`
 *     processes ordered after,
 *   - hide compile-worker / sampling-profiler / async housekeeping
 *     tracks by default.
 *
 * Detection: looks for `(CPU)` / `(GPU N)` process labels and Kineto's
 * `stream N` / `thread N (python)` track-name conventions. Non-PyTorch
 * Chrome traces score 0 and fall back to webDev / raw.
 */

// Kineto track-name patterns. Kept in one place because three call
// sites (match(), trackRules, featureTracks) need the exact same
// shape and we hit a real bug when they drifted: Kineto emits the
// GPU-stream `thread_name` metadata with a trailing space (literal
// `"stream 7 "`), so a `/^stream\s+\d+$/` rule silently misses every
// real-world trace. The trailing `\s*` is load-bearing.
const RE_GPU_STREAM = /^stream\s+\d+\s*$/
const RE_PYTHON_THREAD = /^thread\s+\d+\s*\(python\)\s*$/

const CAT = {
  // Root: yellow DevTools "Scripting". Catch-all for any python_function
  // not classified by a more specific rule, and the overview band color.
  python: 'python',
  // Subcategories of python (parentId: 'python'): all roll up into the
  // single yellow Python band in the overview but paint distinctly in
  // the flame chart.
  userPython: 'userPython',
  thirdPartyPython: 'thirdPartyPython',
  torchPython: 'torchPython',
  // ATen / torch dispatcher (cpu_op). Distinct band so the user can see
  // how much wall time the C++ tensor layer is taking vs Python.
  aten: 'aten',
  // GPU root — overview band only, never directly painted.
  gpu: 'gpu',
  // Kernels: the actual on-device SM compute. Kept at full DevTools
  // pink — this is the headline category for an ML engineer.
  gpuKernel: 'gpuKernel',
  // Memcpy / memset / GPU-side annotations: still GPU work but not
  // compute. Paler pink so kernels stand out at a glance.
  gpuMemory: 'gpuMemory',
  // CUDA runtime / driver API on the CPU side, plus profiler overhead
  // and torch.compile region markers. Neutral gray.
  system: 'system',
  // Fallbacks (mirroring webDev).
  idle: 'idle',
  other: 'other',
} as const

export const ML_ENGINEER_PERSONA: Persona = {
  id: 'ml-engineer',
  name: 'ML Engineer',
  description:
    'PyTorch Kineto interpretation: highlight kernels, separate user / framework / torch Python.',

  match(trace: ParsedTrace): number {
    let score = 0
    for (const sys of trace.timeline.systems) {
      // `process_labels` is surfaced as a `(...)` suffix on the system
      // name by the chrome parser. Strong Kineto signal: every process
      // is named `python` with a `(CPU)` or `(GPU N)` suffix.
      if (/\(GPU\s*\d+\)$/.test(sys.name)) score += 5
      else if (/^python\s*\(CPU\)$/i.test(sys.name)) score += 3

      for (const tr of sys.tracks) {
        // Kineto thread naming: `stream N` for GPU streams, `thread N
        // (python)` for the CPU-side worker threads. Both are unique
        // enough that webDev / generic Chrome traces never produce
        // them.
        if (RE_GPU_STREAM.test(tr.name)) score += 3
        else if (RE_PYTHON_THREAD.test(tr.name)) score += 1
      }
    }
    // Cap so a trace with hundreds of GPU streams doesn't overflow into
    // numerically-suspect territory (and so diff-scoring stays sane in
    // tests). Anything past 30 already wins overwhelmingly against
    // webDev's max of ~6.
    return Math.min(score, 100)
  },

  categories: [
    // Root categories first.
    {id: CAT.python, label: 'Python', color: '#f0c000'},
    {id: CAT.aten, label: 'ATen ops', color: '#ed8936'},
    {id: CAT.gpu, label: 'GPU', color: '#e8457f'},
    {id: CAT.system, label: 'System', color: '#4a5568'},
    {id: CAT.idle, label: 'Idle', color: '#e5e5e5'},
    {id: CAT.other, label: 'Other', color: '#9e9e9e'},

    // Python subcategories — each picks a distinct flame-chart color,
    // but all roll up into the single yellow Python band in the
    // overview via `parentId: CAT.python`.
    {id: CAT.userPython, label: 'User Python', color: '#8ed9c1', parentId: CAT.python},
    // Torch internals share the amber of `aten` ops on purpose: an
    // engineer reading a flame chart wants the torch dispatcher (C++
    // `aten::*` slices) and the Python frames inside `torch/` to read
    // as one continuous "framework" stripe rather than two arbitrary
    // colors. Distinct ids are kept so the overview band rollup
    // (parentId → python) and the per-category aggregator stay
    // independent from `aten`.
    {id: CAT.torchPython, label: 'Torch internals', color: '#ed8936', parentId: CAT.python},
    // Third-party libs (transformers / diffusers / accelerate / …)
    // and the standard library both come through as "code I didn't
    // write but I'm running" — paint them with the same DevTools
    // loading-blue so they read as a single "external Python" stripe
    // distinct from torch (amber) and user code (mint).
    {
      id: CAT.thirdPartyPython,
      label: 'Third-party / stdlib',
      color: '#4398f0',
      parentId: CAT.python,
    },

    // GPU subcategories — kernels at full pink, memory ops paler. Both
    // roll up into the single GPU band in the overview.
    {id: CAT.gpuKernel, label: 'GPU kernel', color: '#e8457f', parentId: CAT.gpu},
    {id: CAT.gpuMemory, label: 'GPU memory', color: '#f59ab9', parentId: CAT.gpu},
  ],

  // Ordered: most specific patterns first. Catch-alls at the bottom.
  // Written against PyTorch Kineto's `cat` values documented at
  // https://pytorch.org/docs/stable/profiler.html and seen in
  // `export_chrome_trace()` output.
  colorRules: [
    // ----- GPU work -----
    // Kernels: the actual on-device compute. This is the headline
    // signal for an ML engineer; route to its own dark-pink subcategory
    // so it stands out from the paler memcpy/memset stripe.
    {traceCategory: /^kernel$/, categoryId: CAT.gpuKernel},
    // GPU-side memory ops + GPU annotation markers: still GPU wall
    // time, but qualitatively different from compute.
    {
      traceCategory: /^(gpu_memcpy|gpu_memset|gpu_user_annotation)$/,
      categoryId: CAT.gpuMemory,
    },

    // ----- System / overhead -----
    // `cudaGraphLaunch` is special: it's a single CPU-side API call
    // that fires off a whole pre-recorded graph of kernels +
    // memcpys. It's not "the CPU is busy" the way `cudaLaunchKernel`
    // is — it's "the CPU just kicked off a batch of GPU work". Color
    // it as GPU memory (pale pink) so the engineer can see at a
    // glance where compiled-graph dispatch happens, instead of
    // burying it in the system gray with the per-kernel launches.
    // Must precede the `cuda_runtime → system` catch-all below.
    {
      traceCategory: /^cuda_runtime$/,
      measureName: /^cudaGraphLaunch/,
      categoryId: CAT.gpuMemory,
    },

    // CUDA API on the CPU side (`cudaLaunchKernel`, `cudaMemcpyAsync`,
    // …) and profiler overhead. Neutral gray so they don't pull the
    // user's eye away from the actual compute.
    {traceCategory: /^(cuda_runtime|cuda_driver|overhead)$/, categoryId: CAT.system},
    // `user_annotation` is `torch.compile`'s `## Call CompiledFxGraph
    // … ##` region markers — useful structurally, but visually they
    // wrap whole subgraphs and would wash the chart out if we colored
    // them. Keep them in the same neutral system bucket.
    {traceCategory: /^user_annotation$/, categoryId: CAT.system},

    // ----- ATen / torch dispatcher -----
    // C++ tensor ops dispatched by the torch eager / compile runtime
    // (`aten::mm`, `aten::view`, …). Their own band so an engineer can
    // see the wall-time tax of dispatch separately from Python.
    {traceCategory: /^cpu_op$/, categoryId: CAT.aten},

    // ----- Python frames -----
    // `python_function` slices' `name` is the synthesized frame label
    // like `torch/_inductor/.../foo.py(123): bar`, `nn.Module:
    // Gemma3Model_0`, or a bare `threading.py(973): _bootstrap` for
    // stdlib. We classify on `measureName`; rule order matters because
    // the regex is first-match-wins.

    // `nn.Module:` wrapper frames are user-facing model structure even
    // when the underlying class lives in `torch.nn` — an engineer
    // navigating their model wants these in the user-Python mint, not
    // hidden inside the torch blue. Run before the `^torch/` rule so
    // they win.
    {traceCategory: /^python_function$/, measureName: /^nn\.Module:/, categoryId: CAT.userPython},

    // Anything under `torch/...` is torch-internal Python.
    {traceCategory: /^python_function$/, measureName: /^torch\//, categoryId: CAT.torchPython},

    // Common third-party HF / training-stack packages users import
    // wholesale. Painted distinctly so the engineer can see whether
    // hot frames are in their own code or under the framework. Anchored
    // at the start of the path so we don't accidentally match a user
    // file named e.g. `my_transformers_helper.py`.
    {
      traceCategory: /^python_function$/,
      measureName:
        /^(transformers|diffusers|accelerate|huggingface_hub|tqdm|safetensors|peft|datasets|tokenizers|optimum)\//,
      categoryId: CAT.thirdPartyPython,
    },

    // Bare `<filename>.py(N): func` — no leading directory. Kineto
    // emits these for stdlib modules (`threading.py`, `queue.py`,
    // `selectors.py`, …). Bucket with third-party libs: both are
    // "external Python the user is running" and read as the same
    // blue stripe.
    {
      traceCategory: /^python_function$/,
      measureName: /^[A-Za-z_][\w]*\.py\(/,
      categoryId: CAT.thirdPartyPython,
    },

    // Anything else — the user's own app / harness / script code, plus
    // any path-shaped frame we didn't otherwise classify. Mint green.
    {traceCategory: /^python_function$/, categoryId: CAT.userPython},

    // ----- Catch-all -----
    {categoryId: CAT.other},
  ],

  // Matches webDev: collapse everything by default, then explicit
  // track/system rules opt the meaningful ones back open.
  defaultTracksExpanded: false,
  defaultSystemsExpanded: false,

  systemRules: [
    // CPU process — this is where every Python frame, ATen op, and
    // CUDA API call lives. Pin to top, expand by default, drop the
    // redundant `python` prefix in the label.
    {
      name: /^python\s*\(CPU\)$/i,
      pinToTop: true,
      defaultExpanded: true,
      sortPriority: 0,
      relabel: 'Python CPU',
    },
    // GPU 0..N processes — visible and sorted right after the CPU
    // process. They start *collapsed*; only the GPU system whose
    // stream is featured by `featureTracks` opens automatically (so
    // a multi-GPU trace with one busy GPU doesn't unfold every empty
    // sibling). We intentionally don't relabel — multiple GPUs stay
    // disambiguated (`python (GPU 0)`, `python (GPU 1)`, …).
    {name: /\(GPU\s*\d+\)$/, sortPriority: 10},
  ],

  trackRules: [
    // GPU streams: sort first within their system, but don't
    // unconditionally expand. `featureTracks` picks the dominant
    // kernel-bearing stream and forces it open; the rest stay
    // collapsed so the user isn't drowned in idle copy streams.
    {trackName: RE_GPU_STREAM, sortPriority: 0},

    // CPU Python threads: same deal. The trace typically has one
    // dominant `thread <pid> (python)` carrying ~all of the wall
    // time and a long tail of short-lived workers. `featureTracks`
    // picks the dominant one by event count.
    {trackName: RE_PYTHON_THREAD, systemName: /\(CPU\)$/, sortPriority: 5},

    // Inductor's compile-worker pool spins up many short-lived threads
    // that mostly run import / codegen plumbing. Hide by default,
    // reachable via the per-system "show hidden" affordance.
    {trackName: /compile_worker/i, hidden: true},
    // Profiler / sampling threads are pure observer overhead.
    {trackName: /StackSamplingProfiler/i, hidden: true},
    {trackName: /Profiler/i, hidden: true},

    // Per-process `Async` virtual track collects ac2g flow events
    // (CPU→GPU launch arrows). Useful as cross-references, but as a
    // standalone track it's a wall of one-line slices that adds noise
    // — mirror webDev and hide.
    {trackCategory: /^async$/, hidden: true},
  ],

  /**
   * Pick the tracks that should be expanded by default for a given
   * trace. Two heuristics:
   *
   *   1. **Dominant CPU Python thread** — across all systems whose
   *      name carries a `(CPU)` suffix, find the `thread <tid>
   *      (python)` track with the most slices and feature it. PyTorch
   *      profiler always concentrates the workload onto a single tid;
   *      the rest are short-lived workers that just clutter the
   *      timeline.
   *   2. **Per-GPU dominant kernel stream** — for each `(GPU N)`
   *      system, find its `stream N` track that carries any `kernel`-
   *      category slices and pick the one with the most. Streams that
   *      only hold memcpy / annotation events stay collapsed, and an
   *      idle GPU system (no kernels at all) features nothing — so
   *      its parent system also stays closed.
   *
   * Slice counts come from {@link Track.buffers} which is already
   * populated by the parser; no additional walking is needed for the
   * "biggest track" comparison. Kernel detection has to scan a
   * track's flat measure list, but only does so for `stream N` tracks
   * inside `(GPU N)` systems and short-circuits on first hit when
   * there are none.
   */
  featureTracks(trace) {
    const featured: string[] = []
    let bestPythonThread: {id: string; count: number} | null = null

    for (const system of trace.timeline.systems) {
      const isCpu = /\(CPU\)$/.test(system.name)
      const isGpu = /\(GPU\s*\d+\)$/.test(system.name)
      if (!isCpu && !isGpu) continue

      if (isCpu) {
        for (const track of system.tracks) {
          if (!RE_PYTHON_THREAD.test(track.name)) continue
          const count = track.buffers?.count ?? track.measures.length
          if (!bestPythonThread || count > bestPythonThread.count) {
            bestPythonThread = {id: track.id, count}
          }
        }
        continue
      }

      // GPU system: pick the dominant kernel stream within this
      // system only, so multi-GPU traces feature one stream per GPU.
      let bestStream: {id: string; count: number} | null = null
      for (const track of system.tracks) {
        if (!RE_GPU_STREAM.test(track.name)) continue
        const measures = track.buffers?.measures ?? track.measures
        let kernelCount = 0
        for (const m of measures) {
          if (m.category === 'kernel') kernelCount += 1
        }
        if (kernelCount === 0) continue
        if (!bestStream || kernelCount > bestStream.count) {
          bestStream = {id: track.id, count: kernelCount}
        }
      }
      if (bestStream) featured.push(bestStream.id)
    }

    if (bestPythonThread) featured.push(bestPythonThread.id)
    return featured
  },

  // Bottom-to-top stack. System sits at the bottom (narrow band of
  // CUDA-API + overhead), then GPU (kernels + memory rolled up), then
  // ATen ops, then Python (all four python subcategories rolled up via
  // parentId). Engineer's eye lands on the headline category at the top.
  overviewOrder: [CAT.system, CAT.gpu, CAT.aten, CAT.python],
}
