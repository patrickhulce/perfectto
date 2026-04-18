import {readdir, readFile, writeFile} from 'fs/promises'
import path from 'path'

const EVENTS_PLACEHOLDER = '@@REPLACE_THIS_VALUE_WITH_THE_EVENTS@@'

async function formatTrace(tracePath: string) {
  const input = await readFile(tracePath, 'utf-8')
  const parsed = JSON.parse(input)
  const events = parsed.traceEvents
  parsed['traceEvents'] = EVENTS_PLACEHOLDER

  const formattedEvents = events.map((event: unknown) => JSON.stringify(event) + ',')
  const formattedRoot = JSON.stringify(parsed, null, 2)
  const indent = ' '.repeat(2)
  const formatted = formattedRoot.replace(
    `"${EVENTS_PLACEHOLDER}"`,
    [
      '[\n',
      formattedEvents.map((event: string) => `${indent.repeat(2)}${event}`).join('\n'),
      `\n${indent}]`,
    ].join(''),
  )

  await writeFile(tracePath, formatted)
}

async function main() {
  const tracesDir = path.join(process.cwd(), 'assets')
  const tracePaths = await readdir(tracesDir, {withFileTypes: true}).then(entries =>
    entries
      .filter(entry => entry.isFile() && entry.name.endsWith('trace.json'))
      .map(entry => path.join(tracesDir, entry.name)),
  )
  console.log(`Formatting ${tracePaths.length} traces...`)
  for (const tracePath of tracePaths) {
    console.log(`Formatting ${tracePath}...`)
    await formatTrace(tracePath)
  }
  console.log('✅ Done!')
}

main()
