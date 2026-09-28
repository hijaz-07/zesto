import { useEffect, useRef, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { IonSelect, IonSelectOption } from '@ionic/react';
import { Button } from '../../components/ui/Button';
import { TextField } from '../../components/ui/TextField';
import { parseRupeesToPaise } from '../../utils/currency';
import type { CreateMenuItemInput, UpdateMenuItemInput } from './api';
import { menuItemErrorMessage } from './errors';
import type { MenuItem } from './types';

const NAME_MAX_LENGTH = 100;
const DESCRIPTION_MAX_LENGTH = 500;

export type MenuItemFormProps =
  | {
      mode: 'create';
      /** A sensible starting value for the new item's `displayOrder` (the caller's current item count); the user may still change it. */
      defaultDisplayOrder: number;
      onSubmit: (input: CreateMenuItemInput) => Promise<MenuItem>;
      onSaved: (item: MenuItem) => void;
      onCancel: () => void;
    }
  | {
      mode: 'edit';
      item: MenuItem;
      onSubmit: (input: UpdateMenuItemInput) => Promise<MenuItem>;
      onSaved: (item: MenuItem) => void;
      onCancel: () => void;
    };

interface FormValues {
  name: string;
  description: string;
  price: string;
  displayOrder: string;
  enabled: 'enabled' | 'disabled';
}

/**
 * Converts stored integer paise into a plain editable rupees string for the
 * price field's default value (e.g. `9950` -> `"99.50"`). Display-only,
 * mirroring `formatPaiseAsRupees`'s own `priceInPaise / 100` — never used as
 * the authoritative conversion (submit always re-derives paise from the
 * field's current text via `parseRupeesToPaise`), so the float division here
 * only ever needs to round-trip back into the same 1-2-decimal string, which
 * it always does since paise is always a whole number.
 */
function priceInputValueFor(priceInPaise: number): string {
  const rupees = priceInPaise / 100;
  return rupees % 1 === 0 ? String(rupees) : rupees.toFixed(2);
}

function defaultValuesFor(props: MenuItemFormProps): FormValues {
  if (props.mode !== 'edit') {
    return {
      name: '',
      description: '',
      price: '',
      displayOrder: String(props.defaultDisplayOrder),
      enabled: 'enabled',
    };
  }
  const { item } = props;
  return {
    name: item.name,
    description: item.description ?? '',
    price: priceInputValueFor(item.priceInPaise),
    displayOrder: String(item.displayOrder),
    enabled: item.enabled ? 'enabled' : 'disabled',
  };
}

/**
 * Shared create/edit menu item form, mirroring `MenuForm`'s shape. Unlike
 * `MenuForm`, there is no menu-status-driven field locking here — the caller
 * (`MenuItemsSection`) only renders this form at all when the parent menu
 * currently permits the operation (see `getMenuItemMutationPermissions`), so
 * every visible field is always editable.
 */
export function MenuItemForm(props: MenuItemFormProps) {
  const { mode, onSaved, onCancel } = props;
  const {
    register,
    handleSubmit,
    control,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ defaultValues: defaultValuesFor(props), mode: 'onBlur' });

  const [formError, setFormError] = useState<string | null>(null);
  const formErrorRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (formError) {
      formErrorRef.current?.focus();
    }
  }, [formError]);

  const nameRegistration = register('name', {
    validate: (value) => value.trim().length > 0 || 'Item name is required.',
    maxLength: { value: NAME_MAX_LENGTH, message: `Must be ${NAME_MAX_LENGTH} characters or fewer.` },
  });
  const descriptionRegistration = register('description', {
    maxLength: { value: DESCRIPTION_MAX_LENGTH, message: `Must be ${DESCRIPTION_MAX_LENGTH} characters or fewer.` },
  });
  const priceRegistration = register('price', {
    validate: {
      required: (value) => value.trim().length > 0 || 'Price is required.',
      valid: (value) =>
        value.trim().length === 0 ||
        parseRupeesToPaise(value) !== null ||
        'Enter a valid price, e.g. 120 or 99.50.',
    },
  });
  const displayOrderRegistration = register('displayOrder', {
    validate: {
      required: (value) => value.trim().length > 0 || 'Display order is required.',
      valid: (value) => {
        if (!value.trim()) {
          return true;
        }
        const parsed = Number(value);
        return (Number.isInteger(parsed) && parsed >= 0) || 'Display order must be a whole number, 0 or greater.';
      },
    },
  });

  const onValid = async (values: FormValues) => {
    setFormError(null);
    const priceInPaise = parseRupeesToPaise(values.price);
    if (priceInPaise === null) {
      return;
    }
    const shared = {
      name: values.name.trim(),
      description: values.description.trim() || undefined,
      priceInPaise,
      displayOrder: Number(values.displayOrder),
    };

    try {
      if (props.mode === 'create') {
        const saved = await props.onSubmit(shared);
        onSaved(saved);
      } else {
        const saved = await props.onSubmit({ ...shared, enabled: values.enabled === 'enabled' });
        onSaved(saved);
      }
    } catch (error) {
      setFormError(menuItemErrorMessage(error));
    }
  };

  return (
    <form onSubmit={handleSubmit(onValid)} className="flex flex-col gap-4" noValidate aria-busy={isSubmitting}>
      <TextField label="Name" placeholder="e.g. Chicken Biriyani" error={errors.name?.message} {...nameRegistration} />
      <TextField
        label="Description"
        placeholder="Optional"
        error={errors.description?.message}
        {...descriptionRegistration}
      />
      <div className="flex flex-col gap-1">
        <TextField
          label="Price"
          placeholder="e.g. 120 or 99.50"
          inputMode="decimal"
          aria-describedby="menu-item-price-help"
          error={errors.price?.message}
          {...priceRegistration}
        />
        <p id="menu-item-price-help" className="text-xs text-muted">
          Enter the price in rupees. Zesto stores it as exact paise, never a rounded decimal.
        </p>
      </div>
      <TextField
        label="Display order"
        type="number"
        min={0}
        step={1}
        inputMode="numeric"
        error={errors.displayOrder?.message}
        {...displayOrderRegistration}
      />

      {mode === 'edit' && (
        <Controller
          name="enabled"
          control={control}
          render={({ field }) => (
            <IonSelect
              label="Availability"
              labelPlacement="stacked"
              interface="popover"
              value={field.value}
              onIonChange={(event) => field.onChange(event.detail.value as 'enabled' | 'disabled')}
            >
              <IonSelectOption value="enabled">Enabled</IonSelectOption>
              <IonSelectOption value="disabled">Disabled</IonSelectOption>
            </IonSelect>
          )}
        />
      )}

      {formError && (
        <p ref={formErrorRef} role="alert" tabIndex={-1} className="text-sm text-danger outline-none">
          {formError}
        </p>
      )}

      <div className="flex items-center gap-2">
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? (mode === 'create' ? 'Creating…' : 'Saving…') : mode === 'create' ? 'Add Item' : 'Save Changes'}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={isSubmitting}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
