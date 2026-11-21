import * as React from "react"
import { Eye, EyeOff } from "lucide-react"

import { cn } from "../../lib/utils"
import { Input } from "./input"

/**
 * A password Input with a show/hide button inside its right edge. It takes every prop Input does
 * except `type`, which the button controls. Put it inside a `Field` for the caption.
 */
function PasswordField({
  className,
  ...props
}: Omit<React.ComponentProps<typeof Input>, "type">) {
  const [shown, setShown] = React.useState(false)
  return (
    <div className="wb-password-field">
      <Input type={shown ? "text" : "password"} className={cn("pr-9", className)} {...props} />
      <button
        type="button"
        aria-label={shown ? "Hide password" : "Show password"}
        onClick={() => setShown((value) => !value)}
      >
        {shown ? <EyeOff size={15} aria-hidden="true" /> : <Eye size={15} aria-hidden="true" />}
      </button>
    </div>
  )
}

export { PasswordField }
