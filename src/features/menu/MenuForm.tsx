import { useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Button } from '../../components/ui/Button';
import { TextField } from '../../components/ui/TextField';
import { businessDateOf, businessTimeOf, businessToday, getOrderingState, toBusinessTimestamp } from '../../utils/date';
import type { CreateMenuInput, UpdateMenuInput } from './api';
import { getMenuEditPermissions } from './editPermissions';
import { menuErrorMessage } from './errors';
import { isOrderingBeforePickup, isOrderingWindowValid, isPickupDateValid, isPickupWindowValid } from './scheduleValidation';
import type { Menu } from './types';

const TITLE_MAX_LENGTH = 100;
const DESCRIPTION_MAX_LENGTH = 500;

export type MenuFormProps =
  | {
      mode: 'create';
      onSubmit: (input: CreateMenuInput) => Promise<Menu>;
      onSaved: (menu: Menu) => void;
      onCancel: () => void;
    }
  | {
      mode: 'edit';
      menu: Menu;
      onSubmit: (input: UpdateMenuInput) => Promise<Menu>;
      onSaved: (menu: Menu) => void;
      onCancel: () => void;
    };

interface FormValues {
  menuDate: string;
  title: string;
  description: string;
  orderingOpensDate: string;
  orderingOpensTime: string;
  orderingClosesDate: string;
  orderingClosesTime: string;
  pickupStartsDate: string;
  pickupStartsTime: string;
  pickupEndsDate: string;
  pickupEndsTime: string;
}

function defaultValuesFor(props: MenuFormProps): FormValues {
  if (props.mode !== 'edit') {
    return {
      menuDate: '',
      title: '',
      description: '',
      orderingOpensDate: '',
      orderingOpensTime: '',
      orderingClosesDate: '',
      orderingClosesTime: '',
      pickupStartsDate: '',
      pickupStartsTime: '',
      pickupEndsDate: '',
      pickupEndsTime: '',
    };
  }
  const { menu } = props;
  return {
    menuDate: menu.menuDate,
    title: menu.title,
    description: menu.description ?? '',
    orderingOpensDate: businessDateOf(menu.orderingOpensAt),
    orderingOpensTime: businessTimeOf(menu.orderingOpensAt),
    orderingClosesDate: businessDateOf(menu.orderingClosesAt),
    orderingClosesTime: businessTimeOf(menu.orderingClosesAt),
    pickupStartsDate: businessDateOf(menu.pickupStartsAt),
    pickupStartsTime: businessTimeOf(menu.pickupStartsAt),
    pickupEndsDate: businessDateOf(menu.pickupEndsAt),
    pickupEndsTime: businessTimeOf(menu.pickupEndsAt),
  };
}

/**
 * Shared create/edit menu form. In edit mode, which fields are editable is
 * driven entirely by `getMenuEditPermissions` (menu status + ordering
 * state) — never a frontend-only assumption; the backend re-validates and
 * rejects independently if a race occurs (see `onValid`'s error handling).
 */
export function MenuForm(props: MenuFormProps) {
  const { mode, onSaved, onCancel } = props;
  const {
    register,
    handleSubmit,
    getValues,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ defaultValues: defaultValuesFor(props), mode: 'onBlur' });

  const [formError, setFormError] = useState<string | null>(null);
  const formErrorRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (formError) {
      formErrorRef.current?.focus();
    }
  }, [formError]);

  const permissions =
    props.mode === 'edit'
      ? getMenuEditPermissions(props.menu.status, getOrderingState(props.menu.orderingOpensAt, props.menu.orderingClosesAt))
      : { canEditSchedule: true, canEditTitleDescription: true, canSave: true };

  const scheduleLocked = props.mode === 'edit' && !permissions.canEditSchedule;
  const detailsLocked = props.mode === 'edit' && !permissions.canEditTitleDescription;
  const showScheduleClosedNotice =
    props.mode === 'edit' && props.menu.status === 'published' && scheduleLocked;

  const validateOrderingWindow = (): true | string => {
    const v = getValues();
    if (!v.orderingOpensDate || !v.orderingOpensTime || !v.orderingClosesDate || !v.orderingClosesTime) {
      return true;
    }
    const opensAt = toBusinessTimestamp(v.orderingOpensDate, v.orderingOpensTime);
    const closesAt = toBusinessTimestamp(v.orderingClosesDate, v.orderingClosesTime);
    return isOrderingWindowValid(opensAt, closesAt) || 'Ordering must open before it closes.';
  };

  const validatePickupWindow = (): true | string => {
    const v = getValues();
    if (!v.pickupStartsDate || !v.pickupStartsTime || !v.pickupEndsDate || !v.pickupEndsTime) {
      return true;
    }
    const startsAt = toBusinessTimestamp(v.pickupStartsDate, v.pickupStartsTime);
    const endsAt = toBusinessTimestamp(v.pickupEndsDate, v.pickupEndsTime);
    return isPickupWindowValid(startsAt, endsAt) || 'Pickup must start before it ends.';
  };

  const validateOrderingVsPickup = (): true | string => {
    const v = getValues();
    if (!v.orderingClosesDate || !v.orderingClosesTime || !v.pickupStartsDate || !v.pickupStartsTime) {
      return true;
    }
    const closesAt = toBusinessTimestamp(v.orderingClosesDate, v.orderingClosesTime);
    const startsAt = toBusinessTimestamp(v.pickupStartsDate, v.pickupStartsTime);
    return isOrderingBeforePickup(closesAt, startsAt) || 'Ordering must close at or before pickup starts.';
  };

  const validatePickupDate = (): true | string => {
    const v = getValues();
    if (!v.pickupStartsDate || !v.pickupStartsTime || !v.menuDate) {
      return true;
    }
    const startsAt = toBusinessTimestamp(v.pickupStartsDate, v.pickupStartsTime);
    return isPickupDateValid(startsAt, v.menuDate) || "Pickup can't start before the menu date.";
  };

  const menuDateRegistration = register('menuDate', {
    required: 'Menu date is required.',
    validate: (value) => value >= businessToday() || "Menu date can't be before today.",
  });
  const titleRegistration = register('title', {
    required: 'Title is required.',
    validate: (value) => value.trim().length > 0 || 'Title is required.',
    maxLength: { value: TITLE_MAX_LENGTH, message: `Must be ${TITLE_MAX_LENGTH} characters or fewer.` },
  });
  const descriptionRegistration = register('description', {
    maxLength: { value: DESCRIPTION_MAX_LENGTH, message: `Must be ${DESCRIPTION_MAX_LENGTH} characters or fewer.` },
  });
  const orderingOpensDateRegistration = register('orderingOpensDate', {
    required: 'Ordering opens date is required.',
  });
  const orderingOpensTimeRegistration = register('orderingOpensTime', {
    required: 'Ordering opens time is required.',
  });
  const orderingClosesDateRegistration = register('orderingClosesDate', {
    required: 'Ordering closes date is required.',
    validate: validateOrderingWindow,
  });
  const orderingClosesTimeRegistration = register('orderingClosesTime', {
    required: 'Ordering closes time is required.',
  });
  const pickupStartsDateRegistration = register('pickupStartsDate', {
    required: 'Pickup starts date is required.',
    validate: { vsOrdering: validateOrderingVsPickup, vsMenuDate: validatePickupDate },
  });
  const pickupStartsTimeRegistration = register('pickupStartsTime', {
    required: 'Pickup starts time is required.',
  });
  const pickupEndsDateRegistration = register('pickupEndsDate', {
    required: 'Pickup ends date is required.',
    validate: validatePickupWindow,
  });
  const pickupEndsTimeRegistration = register('pickupEndsTime', {
    required: 'Pickup ends time is required.',
  });

  const onValid = async (values: FormValues) => {
    setFormError(null);
    const titleDescription = {
      title: values.title.trim(),
      description: values.description.trim() || undefined,
    };
    const schedule = {
      menuDate: values.menuDate,
      orderingOpensAt: toBusinessTimestamp(values.orderingOpensDate, values.orderingOpensTime),
      orderingClosesAt: toBusinessTimestamp(values.orderingClosesDate, values.orderingClosesTime),
      pickupStartsAt: toBusinessTimestamp(values.pickupStartsDate, values.pickupStartsTime),
      pickupEndsAt: toBusinessTimestamp(values.pickupEndsDate, values.pickupEndsTime),
    };

    try {
      if (props.mode === 'create') {
        const saved = await props.onSubmit({ ...titleDescription, ...schedule });
        onSaved(saved);
      } else {
        const input: UpdateMenuInput = permissions.canEditSchedule ? { ...titleDescription, ...schedule } : titleDescription;
        const saved = await props.onSubmit(input);
        onSaved(saved);
      }
    } catch (error) {
      setFormError(menuErrorMessage(error));
    }
  };

  return (
    <form onSubmit={handleSubmit(onValid)} className="flex flex-col gap-4" noValidate aria-busy={isSubmitting}>
      <div className="flex flex-col gap-4 rounded-lg border border-border p-3">
        <p className="text-sm font-medium text-text">Basic Information</p>
        <TextField
          label="Menu date"
          type="date"
          min={businessToday()}
          disabled={scheduleLocked}
          error={errors.menuDate?.message}
          {...menuDateRegistration}
        />
        <TextField label="Title" disabled={detailsLocked} error={errors.title?.message} {...titleRegistration} />
        <TextField
          label="Description"
          placeholder="Optional"
          disabled={detailsLocked}
          error={errors.description?.message}
          {...descriptionRegistration}
        />
      </div>

      {showScheduleClosedNotice && (
        <p role="status" className="rounded-lg bg-background px-3 py-2 text-xs text-muted">
          Ordering has closed. Schedule changes are no longer available.
        </p>
      )}

      <div className="flex flex-col gap-4 rounded-lg border border-border p-3">
        <p className="text-sm font-medium text-text">Ordering Window</p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <TextField
            label="Opens date"
            type="date"
            disabled={scheduleLocked}
            error={errors.orderingOpensDate?.message}
            {...orderingOpensDateRegistration}
          />
          <TextField
            label="Opens time"
            type="time"
            disabled={scheduleLocked}
            error={errors.orderingOpensTime?.message}
            {...orderingOpensTimeRegistration}
          />
          <TextField
            label="Closes date"
            type="date"
            disabled={scheduleLocked}
            error={errors.orderingClosesDate?.message}
            {...orderingClosesDateRegistration}
          />
          <TextField
            label="Closes time"
            type="time"
            disabled={scheduleLocked}
            error={errors.orderingClosesTime?.message}
            {...orderingClosesTimeRegistration}
          />
        </div>
      </div>

      <div className="flex flex-col gap-4 rounded-lg border border-border p-3">
        <p className="text-sm font-medium text-text">Pickup Window</p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <TextField
            label="Starts date"
            type="date"
            disabled={scheduleLocked}
            error={errors.pickupStartsDate?.message}
            {...pickupStartsDateRegistration}
          />
          <TextField
            label="Starts time"
            type="time"
            disabled={scheduleLocked}
            error={errors.pickupStartsTime?.message}
            {...pickupStartsTimeRegistration}
          />
          <TextField
            label="Ends date"
            type="date"
            disabled={scheduleLocked}
            error={errors.pickupEndsDate?.message}
            {...pickupEndsDateRegistration}
          />
          <TextField
            label="Ends time"
            type="time"
            disabled={scheduleLocked}
            error={errors.pickupEndsTime?.message}
            {...pickupEndsTimeRegistration}
          />
        </div>
      </div>

      {formError && (
        <p ref={formErrorRef} role="alert" tabIndex={-1} className="text-sm text-danger outline-none">
          {formError}
        </p>
      )}

      <div className="flex items-center gap-2">
        {(mode === 'create' || permissions.canSave) && (
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? (mode === 'create' ? 'Creating…' : 'Saving…') : mode === 'create' ? 'Create Draft' : 'Save Changes'}
          </Button>
        )}
        <Button type="button" variant="ghost" onClick={onCancel} disabled={isSubmitting}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
