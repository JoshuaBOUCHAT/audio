import { Button } from "@/components/ui/button"
import { AuthDebug } from "@/debug/AuthDebug"

function App() {
  if (window.location.pathname === "/debug") return <AuthDebug />

  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-4">
      <h1 className="text-2xl font-semibold">Chat — squelette front</h1>
      <Button>shadcn/ui fonctionne</Button>
    </div>
  )
}

export default App
