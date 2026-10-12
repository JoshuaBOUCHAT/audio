import { useEffect, useState, useSyncExternalStore } from "react"
import { BACK_END_URL } from "@/lib/config"
import { ChatView } from "./ChatView"
import { Login } from "./Login"
import { PseudoScreen } from "./PseudoScreen"
import { takeMagicLinkToken } from "./session"
import { ChatStore } from "./store"

export function ChatApp() {
  const [store] = useState(() => new ChatStore(takeMagicLinkToken()))
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot)

  useEffect(() => {
    store.start()
    return () => store.dispose()
  }, [store])

  if (state.me && !state.me.pseudo && state.phase !== "authenticating") {
    return <PseudoScreen state={state} store={store} />
  }
  if (state.me && (state.phase === "ready" || state.phase === "offline")) {
    return <ChatView state={state} store={store} />
  }
  if (state.phase === "login" || (state.phase === "authenticating" && !state.me)) {
    return <Login state={state} store={store} />
  }
  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-2 p-4 text-center text-sm text-muted-foreground">
      <p>Connexion au serveur…</p>
      <p>
        En dev, accepter une fois le certificat auto-signé sur{" "}
        <a className="underline" href={BACK_END_URL.replace(/^wss:/, "https:")}>
          {BACK_END_URL.replace(/^wss:/, "https:")}
        </a>
        .
      </p>
    </div>
  )
}
