import * as React from "react"
import { Eye, EyeOff } from "lucide-react"

/**
 * A password input with a show/hide button inside its right edge. The input takes every prop a
 * plain `<input>` does except `type`, which the button controls. Put it inside a `Field` for the
 * caption; the input's look comes from `.wb-field input`.
 */
function PasswordField({
  className,
  ref,
  ...props
}: Omit<React.ComponentProps<"input">, "type">) {
  const [shown, setShown] = React.useState(false)
  return (
    <div className="wb-password-field">
      <input ref={ref} type={shown ? "text" : "password"} className={className} {...props} />
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
