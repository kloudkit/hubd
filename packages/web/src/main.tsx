import { type Person, Shell, UserMenu, Wordmark } from '@hubd/ui'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'

type Me = { mode: 'none' | 'token' | 'oidc'; user: Person | null }

async function signOut() {
  await fetch('/auth/logout', { method: 'POST' })
  location.replace('/auth/login')
}

function App({ me }: { me: Me }) {
  return (
    <Shell
      header={
        <>
          <Wordmark />
          <div className="flex-1" />
          <UserMenu person={me.user} onSignOut={me.mode === 'oidc' ? signOut : undefined} />
        </>
      }
    >
      <section className="m-auto flex max-w-xl flex-col items-center gap-4 text-center">
        <span className="rounded-full bg-accent-soft px-3 py-1 text-[12px] font-bold tracking-[0.08em] text-accent uppercase">
          Coming soon
        </span>
        <h1 className="text-[44px] leading-[1.05] font-extrabold tracking-[-0.02em]">
          Mission control for your agents
        </h1>
        <p className="text-[16px] text-ink-2">
          {me.user ? `Signed in as ${me.user.name || me.user.email}. ` : ''}The hubd interface is on its way.
        </p>
      </section>
    </Shell>
  )
}

const me: Me = await fetch('/auth/me')
  .then((r) => r.json() as Promise<Me>)
  .catch(() => ({ mode: 'none', user: null }))

if (me.mode === 'oidc' && !me.user) location.replace('/auth/login')
else {
  const root = document.getElementById('root')
  if (root) {
    createRoot(root).render(
      <StrictMode>
        <App me={me} />
      </StrictMode>,
    )
  }
}
