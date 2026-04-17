export const PREVIEW_CHARS = 10000

export function loadFile(file, previewChars = PREVIEW_CHARS) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = (e) => {
      const text = e.target.result
      resolve({
        name: file.name,
        size: file.size,
        preview: text.slice(0, previewChars),
        totalLength: text.length,
        truncated: text.length > previewChars,
      })
    }
    reader.onerror = () => reject(reader.error)
    reader.readAsText(file)
  })
}
