import { ChatApp } from "@/chat/ChatApp"
import { AuthDebug } from "@/debug/AuthDebug"

function App() {
  if (window.location.pathname === "/debug") return <AuthDebug />
  return <ChatApp />
}

export default App
