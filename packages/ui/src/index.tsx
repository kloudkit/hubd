import { autoUpdate, flip, offset, shift, useDismiss, useFloating, useInteractions, useRole } from '@floating-ui/react'
import { LogOut, User } from 'lucide-react'
import { type ReactNode, useState } from 'react'

export type Person = { name: string; email: string }

export function Wordmark({ href = '/' }: { href?: string }) {
  return (
    <a
      href={href}
      aria-label="hubd home"
      className="rounded-md text-[14px] leading-none tracking-[0.04em] hover:opacity-70"
    >
      <span className="font-medium">HUB</span>
      <span className="font-extrabold text-accent">D</span>
    </a>
  )
}

export function Shell({ header, children }: { header: ReactNode; children: ReactNode }) {
  return (
    <div className="h-dvh min-h-[640px] p-4 lg:p-6">
      <div className="mx-auto flex h-full max-w-[1840px] flex-col rounded-[40px] bg-shell p-6 shadow-shell lg:p-8">
        <header className="mb-8 flex items-center gap-8">{header}</header>
        <main className="flex flex-1 flex-col">{children}</main>
      </div>
    </div>
  )
}

export function initials(person: Person): string {
  const n = (person.name || person.email).trim()
  const parts = n
    .replace(/@.*/, '')
    .split(/[\s._-]+/)
    .filter(Boolean)
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || n.slice(0, 1).toUpperCase()
}

const item =
  'flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-[13px] font-semibold text-ink-2 hover:bg-sunken/60 hover:text-ink'

export function UserMenu({ person, onSignOut }: { person: Person | null; onSignOut?: () => void }) {
  const [open, setOpen] = useState(false)
  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: setOpen,
    placement: 'bottom-end',
    middleware: [offset(8), flip(), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  })
  const { getReferenceProps, getFloatingProps } = useInteractions([useDismiss(context), useRole(context)])
  const label = person ? `Account: ${person.name || person.email}` : 'Account'
  return (
    <>
      <button
        ref={refs.setReference}
        type="button"
        aria-label={label}
        title={person ? person.name || person.email : undefined}
        onClick={() => setOpen(!open)}
        className={`press grid size-10 place-items-center rounded-full text-[13px] font-bold ${person ? 'bg-ink text-on-ink' : 'bg-card text-ink-2 shadow-card'}`}
        {...getReferenceProps()}
      >
        {person ? initials(person) : <User size={16} />}
      </button>
      {open && (
        <div
          ref={refs.setFloating}
          style={floatingStyles}
          className="z-50 w-64 rounded-2xl bg-card p-2 shadow-lift"
          {...getFloatingProps()}
        >
          {person && (
            <div className="px-3 pt-2 pb-3">
              <div className="truncate text-[14px] font-semibold">{person.name || person.email}</div>
              {person.name && <div className="truncate text-[12px] text-ink-3">{person.email}</div>}
            </div>
          )}
          {onSignOut && (
            <>
              <div className="mx-3 my-1 h-px bg-hair" />
              <button type="button" onClick={onSignOut} className={item}>
                <LogOut size={13} />
                Sign out
              </button>
            </>
          )}
        </div>
      )}
    </>
  )
}
