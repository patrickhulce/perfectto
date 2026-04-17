import { useState } from 'react'
import Splash from './components/Splash.jsx'
import Viewer from './components/Viewer.jsx'
import { loadFile } from './utils/loadFile.js'

export default function App() {
  const [trace, setTrace] = useState(null)

  const handleFileSelected = async (file) => {
    const result = await loadFile(file)
    setTrace(result)
  }

  if (trace) {
    return <Viewer trace={trace} onBack={() => setTrace(null)} />
  }
  return <Splash onFileSelected={handleFileSelected} />
}
