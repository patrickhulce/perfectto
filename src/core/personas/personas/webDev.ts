import type {ParsedTrace} from '../../types'
import type {Persona} from '../types'

/**
 * "Web Developer" persona. Interprets a Chrome / Chromium trace the way
 * Chrome DevTools' Performance panel does:
 *
 *   - colorize slices by high-level activity (Loading, Scripting,
 *     Rendering, Painting, GPU, System),
 *   - promote `CrRendererMain` to the top and rename it "Main",
 *     matching the DevTools "Main" row,
 *   - demote / hide the Chromium plumbing threads most web devs don't
 *     want to see by default (ThreadPool*, StackSamplingProfiler, …),
 *   - stack the six activity categories in the overview chart.
 *
 * Designed for Chrome JSON traces where thread names are `CrRendererMain`,
 * `CrBrowserMain`, `Compositor`, etc. Non-Chrome traces score 0 on
 * `match` and fall back to the `raw` persona.
 */

const CAT = {
  loading: 'loading',
  scripting: 'scripting',
  // User JS call-stack frames synthesized from V8 CPU-profile samples.
  // Visually distinct from `scripting` so the deep user-code tower reads
  // apart from the EvaluateScript / v8.run / Compile infrastructure that
  // wraps it. Same overview band, different flame-chart color.
  userScript: 'userScript',
  rendering: 'rendering',
  painting: 'painting',
  gpu: 'gpu',
  system: 'system',
  idle: 'idle',
  other: 'other',
} as const

export const WEB_DEV_PERSONA: Persona = {
  id: 'web-dev',
  name: 'Web Developer',
  description:
    'Chrome DevTools-style interpretation: main thread first, activity colors, hide plumbing.',

  match(trace: ParsedTrace): number {
    let score = 0
    for (const sys of trace.timeline.systems) {
      for (const tr of sys.tracks) {
        const name = tr.name
        if (name === 'CrRendererMain') score += 3
        else if (name === 'CrBrowserMain') score += 1
        else if (name === 'Compositor') score += 1
        else if (name === 'CrGpuMain') score += 1
      }
    }
    return score
  },

  categories: [
    // Root categories (no `parentId`) — each defines both the flame-chart
    // color and the overview stripe color. Colors chosen to closely match
    // Chrome DevTools' Performance panel.
    {id: CAT.loading, label: 'Loading', color: '#4398f0'},
    {id: CAT.scripting, label: 'Scripting', color: '#f0c000'},
    // Subcategory of Scripting: the flame chart paints user JS in a
    // light mint distinct from the yellow EvaluateScript / v8.run /
    // Compile infrastructure that wraps it, but the overview still
    // rolls this wall time into the Scripting band via `parentId`.
    {id: CAT.userScript, label: 'User JS', color: '#8ed9c1', parentId: CAT.scripting},
    {id: CAT.rendering, label: 'Rendering', color: '#9a4ca2'},
    {id: CAT.painting, label: 'Painting', color: '#4e9a06'},
    // Warm rose, deliberately far from the Rendering violet it used to
    // sit next to in the overview stack — the two purples blurred into
    // a single stripe at low zoom. Pink also matches the "GPU /
    // presentation" hue most perf tools reach for.
    {id: CAT.gpu, label: 'GPU', color: '#e8457f'},
    {id: CAT.system, label: 'System', color: '#4a5568'},
    // Deliberately omitted from `overviewOrder` below so they contribute
    // no overview stripe — idle / unclassified time reads as the dark
    // gap between bands, matching DevTools.
    {id: CAT.idle, label: 'Idle', color: '#e5e5e5'},
    {id: CAT.other, label: 'Other', color: '#9e9e9e'},
  ],

  // Order matters: first-matching rule wins. Keep the more-specific
  // patterns above the catch-alls. Written against the devtools timeline
  // event names documented at
  // https://chromium.googlesource.com/chromium/src/+/main/docs/devtools/debugger-protocol.md
  // and the blink/v8/cc categories those events ship with.
  colorRules: [
    // JS-frame slices synthesized from V8 CPU-profile samples. The parser
    // tags them with `category: 'jsFrame'`; route them into their own
    // mint-green `userScript` bucket so the deep user-code call stack
    // reads apart from the yellow EvaluateScript / v8.run / Compile
    // infrastructure wrapping it.
    {traceCategory: /^jsFrame$/, categoryId: CAT.userScript},

    // Scheduler plumbing. `RunTask` (and its aliases) are the generic
    // "the main thread ran a task" wrappers Chrome posts around every
    // unit of work — timers, input, IPC, etc. DevTools renders them in
    // a neutral gray because they're not meaningful "scripting" by
    // themselves, and they'd otherwise wash the chart out in yellow.
    {measureName: /^(RunTask|ThreadControllerImpl::RunTask)$/, categoryId: CAT.system},

    // Loading / network.
    {
      measureName:
        /^(ParseHTML|ParseAuthorStyleSheet|ResourceSendRequest|ResourceReceive(Response|Data)?|ResourceFinish|ResourceWillSendRequest|XHRLoad|XHRReadyStateChange|CommitLoad|WebSocket|DomContentLoadedEventEnd|LoadEventEnd|NavigationStart|MarkLoad|MarkDOMContent)$/i,
      categoryId: CAT.loading,
    },
    {traceCategory: /(^|,)(blink\.resource|loading|navigation)($|,)/i, categoryId: CAT.loading},

    // Scripting / V8 / JS execution.
    {
      measureName:
        /^(v8\.|V8\.|FunctionCall|EvaluateScript|EvaluateModule|CompileScript|CompileCode|CompileModule|MinorGC|MajorGC|GC|GCEvent|TimerFire|TimerInstall|TimerRemove|EventDispatch|RunMicrotasks|RunTask|ParseScriptOnBackground|XHRReadyStateChange|ScheduledAction::execute|AsyncTask|ScriptStreamer)/i,
      categoryId: CAT.scripting,
    },
    {
      traceCategory: /(^|,)(v8|disabled-by-default-v8|v8\.execute|devtools\.timeline\.stack)($|,)/i,
      categoryId: CAT.scripting,
    },

    // Rendering / layout / style.
    {
      measureName:
        /^(Layout|UpdateLayoutTree|UpdateLayerTree|RecalculateStyles|ScheduleStyleRecalculation|InvalidateLayout|ComputedStyle|PreLayout|HitTest|Animation|RequestMainThreadFrame|BeginMainThreadFrame)/i,
      categoryId: CAT.rendering,
    },
    {
      traceCategory: /(^|,)(blink|blink\.animations|blink\.console)($|,)/i,
      categoryId: CAT.rendering,
    },

    // Painting / raster / compositing.
    {
      measureName:
        /^(Paint|PaintImage|PrePaint|RasterTask|CompositeLayers|CompositeFrame|CommitPendingTree|DrawFrame|DrawLazyPixelRef|DecodeImage|ResizeImage|Decode Image|Decode LazyPixelRef)/i,
      categoryId: CAT.painting,
    },
    {
      traceCategory: /(^|,)(cc|viz|disabled-by-default-cc\.debug|disabled-by-default-viz\.debug)($|,)/i,
      categoryId: CAT.painting,
    },

    // GPU process / swap / presentation.
    {
      measureName: /^(GPU|GLRenderer|SwapBuffers|GpuMemoryBuffer|PresentationFrame)/i,
      categoryId: CAT.gpu,
    },
    {systemName: /gpu process/i, categoryId: CAT.gpu},

    // System / scheduling overhead.
    {
      measureName:
        /^(ThreadControllerImpl|TaskQueueManager|MessageLoop|PostTask|ProcessTask|SequenceManager)/i,
      categoryId: CAT.system,
    },
    {traceCategory: /(^|,)(toplevel|toplevel\.flow|scheduler)($|,)/i, categoryId: CAT.system},

    // Catch-all — gives any remaining slice a consistent, muted color.
    {categoryId: CAT.other},
  ],

  // Collapse-by-default: only tracks / systems that explicitly opt into
  // `defaultExpanded: true` / `defaultSystemExpanded: true` start open.
  // Matches Chrome DevTools' "show what matters, hide the plumbing"
  // posture.
  defaultTracksExpanded: false,
  defaultSystemsExpanded: false,

  systemRules: [
    // Kernel idle / swapper process — noise for a web dev, and
    // typically at the very top of the list because pid 0 sorts first.
    // Hide; the reveal affordance at the bottom of the timeline still
    // lets curious users click through.
    {name: /^(Process 0|swapper)$/i, hidden: true},
  ],

  trackRules: [
    // The renderer main thread is the star of the show: pin to top,
    // relabel to "Main", force both track and system expanded.
    {
      trackName: /^CrRendererMain$/,
      sortPriority: 0,
      pinToTop: true,
      relabel: 'Main',
      defaultExpanded: true,
      defaultSystemExpanded: true,
    },
    // Browser main thread — second priority. Stays visible but
    // collapses along with the Browser system by default; user can
    // expand to drill in.
    {trackName: /^CrBrowserMain$/, sortPriority: 10},
    // Compositor / GPU main — visible but collapsed by default
    // (redundant with the persona baseline, kept for self-documentation).
    {trackName: /^Compositor$/, sortPriority: 20, defaultExpanded: false},
    {trackName: /^CrGpuMain$/, sortPriority: 20, defaultExpanded: false},
    // I/O threads — visible, collapsed.
    {trackName: /^Chrome_ChildIOThread$/, sortPriority: 30, defaultExpanded: false},
    {trackName: /^Chrome_IOThread$/, sortPriority: 30, defaultExpanded: false},
    // Raster / compositor tile worker threads — visible, collapsed.
    {trackName: /^CompositorTileWorker/, sortPriority: 40, defaultExpanded: false},

    // Per-process "Async" virtual tracks are not actionable for a web
    // dev and mostly add noise — hide them across every system.
    {trackCategory: /^async$/, hidden: true},

    // Chromium plumbing threads most web devs don't care about — hide
    // by default, reachable via the "show hidden" affordance.
    {trackName: /^ThreadPool/, hidden: true},
    {trackName: /^StackSamplingProfiler$/, hidden: true},
    {trackName: /^MemoryInfra$/, hidden: true},
    {trackName: /^CrRendererBlinkWorker/, hidden: true},
    {trackName: /^HangWatcher$/, hidden: true},
    {trackName: /^CacheThread/, hidden: true},
    {trackName: /^Media$/, hidden: true},
  ],

  // Rendered bottom-to-top. System at the bottom (narrow band of
  // scheduling overhead), then GPU, Painting, Rendering, Scripting,
  // Loading on top — so the "what users feel" categories are visually
  // dominant, matching DevTools' emphasis. `userScript` is intentionally
  // absent: it rolls into `scripting` via its `parentId` at apply time.
  overviewOrder: [
    CAT.system,
    CAT.gpu,
    CAT.painting,
    CAT.rendering,
    CAT.scripting,
    CAT.loading,
  ],
}
