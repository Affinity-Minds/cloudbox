// Shared reason-picker for every revoke/retire/archive/delete confirmation (owner brief:
// "dropdown of reasons plus Other with a free-text field", docs/handoffs/wt-p2-reason-dropdowns.md).
// The `options` list must match the action's zod enum in `@cloudbox/contracts/reasons` — the API
// validates the same codes, so a dialog can't drift from what the server accepts.
import { useId } from "react";
import type { ReasonRequestBody } from "@/api/client";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

export type { ReasonRequestBody } from "@/api/client";
export type ReasonOption = { code: string; label: string };
export type ReasonValue = { code: string; text?: string };

const OTHER_CODE = "other";
const OTHER_MIN_LENGTH = 5;

/** True once the value is postable: a code is chosen, and free text (min 5 chars) is present
 * whenever that code is `"other"`. */
export function isReasonValid(value: ReasonValue): boolean {
  if (!value.code) return false;
  if (value.code === OTHER_CODE) return (value.text?.trim().length ?? 0) >= OTHER_MIN_LENGTH;
  return true;
}

/** `{ reasonCode, reasonText }` body for the mutation — `reasonText` only travels for "other". */
export function reasonRequestBody(value: ReasonValue): ReasonRequestBody {
  return {
    reasonCode: value.code,
    reasonText: value.code === OTHER_CODE ? value.text?.trim() : undefined,
  };
}

export function ReasonSelect({
  options,
  value,
  onChange,
  label = "Reason",
  placeholder = "Select a reason",
  textareaPlaceholder = "Add a few words on what happened",
  disabled,
}: {
  options: ReasonOption[];
  value: ReasonValue;
  onChange: (value: ReasonValue) => void;
  label?: string;
  placeholder?: string;
  textareaPlaceholder?: string;
  disabled?: boolean;
}) {
  const reactId = useId();
  const selectId = `reason-select-${reactId}`;
  const textareaId = `reason-select-text-${reactId}`;
  const isOther = value.code === OTHER_CODE;
  const textTooShort = isOther && (value.text?.trim().length ?? 0) < OTHER_MIN_LENGTH;

  return (
    <Field>
      <FieldLabel htmlFor={selectId}>{label}</FieldLabel>
      <Select
        value={value.code || undefined}
        onValueChange={(code) =>
          onChange({ code, text: code === OTHER_CODE ? value.text : undefined })
        }
        disabled={disabled}
      >
        <SelectTrigger id={selectId} className="w-full">
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.code} value={option.code}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {isOther ? (
        <>
          <FieldLabel htmlFor={textareaId} className="sr-only">
            Reason detail
          </FieldLabel>
          <Textarea
            id={textareaId}
            value={value.text ?? ""}
            onChange={(e) => onChange({ code: value.code, text: e.target.value })}
            placeholder={textareaPlaceholder}
            maxLength={500}
            disabled={disabled}
            autoFocus
          />
          {textTooShort ? (
            <FieldDescription className="text-destructive">
              Add at least {OTHER_MIN_LENGTH} characters.
            </FieldDescription>
          ) : null}
        </>
      ) : null}
    </Field>
  );
}
