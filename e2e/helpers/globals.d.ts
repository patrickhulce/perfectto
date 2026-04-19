export {}

declare global {
  interface Window {
    __perfecttoLongTasks?: Array<{start: number; dur: number}>
  }
}
