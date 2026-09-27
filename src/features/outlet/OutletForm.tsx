import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { IonSelect, IonSelectOption } from '@ionic/react';
import type { Outlet, OutletAddress, OutletLocation, OutletStatus } from '../../domain/types';
import { Button } from '../../components/ui/Button';
import { TextField } from '../../components/ui/TextField';
import { ApiError } from '../../lib/api/client';
import { SLUG_MAX_LENGTH, SLUG_MIN_LENGTH, SLUG_PATTERN, suggestSlug } from '../../utils/slug';
import type { CreateOutletInput, UpdateOutletInput } from './api';
import { outletErrorMessage } from './errors';

const NAME_MAX_LENGTH = 100;
const DESCRIPTION_MAX_LENGTH = 500;
const PHONE_MAX_LENGTH = 30;
const ADDRESS_LINE_MAX_LENGTH = 200;
const ADDRESS_CITY_MAX_LENGTH = 100;
const ADDRESS_STATE_MAX_LENGTH = 100;
const ADDRESS_POSTAL_CODE_MAX_LENGTH = 20;

export type OutletFormProps =
  | {
      mode: 'create';
      onSubmit: (input: CreateOutletInput) => Promise<Outlet>;
      onSaved: (outlet: Outlet) => void;
      onCancel: () => void;
    }
  | {
      mode: 'edit';
      outlet: Outlet;
      onSubmit: (input: UpdateOutletInput) => Promise<Outlet>;
      onSaved: (outlet: Outlet) => void;
      onCancel: () => void;
    };

interface FormValues {
  name: string;
  slug: string;
  description: string;
  phone: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  state: string;
  postalCode: string;
  latitude: string;
  longitude: string;
  status: OutletStatus;
}

function defaultValuesFor(props: OutletFormProps): FormValues {
  const outlet = props.mode === 'edit' ? props.outlet : undefined;
  return {
    name: outlet?.name ?? '',
    slug: outlet?.slug ?? '',
    description: outlet?.description ?? '',
    phone: outlet?.phone ?? '',
    addressLine1: outlet?.address?.line1 ?? '',
    addressLine2: outlet?.address?.line2 ?? '',
    city: outlet?.address?.city ?? '',
    state: outlet?.address?.state ?? '',
    postalCode: outlet?.address?.postalCode ?? '',
    latitude: outlet?.location?.latitude !== undefined ? String(outlet.location.latitude) : '',
    longitude: outlet?.location?.longitude !== undefined ? String(outlet.location.longitude) : '',
    status: outlet?.status ?? 'active',
  };
}

function buildAddress(values: FormValues): OutletAddress | undefined {
  const address: OutletAddress = {
    line1: values.addressLine1.trim() || undefined,
    line2: values.addressLine2.trim() || undefined,
    city: values.city.trim() || undefined,
    state: values.state.trim() || undefined,
    postalCode: values.postalCode.trim() || undefined,
  };
  return Object.values(address).some((value) => value !== undefined) ? address : undefined;
}

function buildLocation(values: FormValues): OutletLocation | undefined {
  if (!values.latitude.trim() && !values.longitude.trim()) {
    return undefined;
  }
  return { latitude: Number(values.latitude), longitude: Number(values.longitude) };
}

/** Shared create/edit outlet form. `slug` is only ever collected on create — see `props.mode`. */
export function OutletForm(props: OutletFormProps) {
  const { mode, onSaved, onCancel } = props;
  const {
    register,
    handleSubmit,
    setValue,
    setError,
    getValues,
    control,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ defaultValues: defaultValuesFor(props), mode: 'onBlur' });

  const slugTouchedRef = useRef(mode === 'edit');
  const [formError, setFormError] = useState<string | null>(null);
  const formErrorRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (formError) {
      formErrorRef.current?.focus();
    }
  }, [formError]);

  const handleNameChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      if (!slugTouchedRef.current) {
        setValue('slug', suggestSlug(event.target.value));
      }
    },
    [setValue],
  );

  const handleSlugChange = useCallback(() => {
    slugTouchedRef.current = true;
  }, []);

  const onValid = async (values: FormValues) => {
    setFormError(null);
    const shared = {
      name: values.name.trim(),
      description: values.description.trim() || undefined,
      phone: values.phone.trim() || undefined,
      address: buildAddress(values),
      location: buildLocation(values),
    };

    try {
      const saved =
        props.mode === 'create'
          ? await props.onSubmit({ ...shared, slug: values.slug.trim() })
          : await props.onSubmit({ ...shared, status: values.status });
      onSaved(saved);
    } catch (error) {
      if (mode === 'create' && error instanceof ApiError && error.code === 'already_exists') {
        setError('slug', { type: 'manual', message: error.message });
        return;
      }
      setFormError(outletErrorMessage(error));
    }
  };

  // eslint-disable-next-line react-hooks/refs
  const nameRegistration = register('name', {
    required: 'Outlet name is required.',
    maxLength: { value: NAME_MAX_LENGTH, message: `Must be ${NAME_MAX_LENGTH} characters or fewer.` },
    onChange: handleNameChange,
  });
  // eslint-disable-next-line react-hooks/refs
  const slugRegistration = register('slug', {
    required: 'Slug is required.',
    minLength: { value: SLUG_MIN_LENGTH, message: `Must be at least ${SLUG_MIN_LENGTH} characters.` },
    maxLength: { value: SLUG_MAX_LENGTH, message: `Must be ${SLUG_MAX_LENGTH} characters or fewer.` },
    pattern: { value: SLUG_PATTERN, message: 'Use lowercase letters, numbers, and single hyphens only.' },
    onChange: handleSlugChange,
  });
  const descriptionRegistration = register('description', {
    maxLength: { value: DESCRIPTION_MAX_LENGTH, message: `Must be ${DESCRIPTION_MAX_LENGTH} characters or fewer.` },
  });
  const phoneRegistration = register('phone', {
    maxLength: { value: PHONE_MAX_LENGTH, message: `Must be ${PHONE_MAX_LENGTH} characters or fewer.` },
  });
  const addressLine1Registration = register('addressLine1', {
    maxLength: { value: ADDRESS_LINE_MAX_LENGTH, message: `Must be ${ADDRESS_LINE_MAX_LENGTH} characters or fewer.` },
  });
  const addressLine2Registration = register('addressLine2', {
    maxLength: { value: ADDRESS_LINE_MAX_LENGTH, message: `Must be ${ADDRESS_LINE_MAX_LENGTH} characters or fewer.` },
  });
  const cityRegistration = register('city', {
    maxLength: { value: ADDRESS_CITY_MAX_LENGTH, message: `Must be ${ADDRESS_CITY_MAX_LENGTH} characters or fewer.` },
  });
  const stateRegistration = register('state', {
    maxLength: { value: ADDRESS_STATE_MAX_LENGTH, message: `Must be ${ADDRESS_STATE_MAX_LENGTH} characters or fewer.` },
  });
  const postalCodeRegistration = register('postalCode', {
    maxLength: {
      value: ADDRESS_POSTAL_CODE_MAX_LENGTH,
      message: `Must be ${ADDRESS_POSTAL_CODE_MAX_LENGTH} characters or fewer.`,
    },
  });
  const latitudeRegistration = register('latitude', {
    validate: (value) => {
      if (!value.trim()) {
        return getValues('longitude').trim() ? 'Latitude is required when longitude is set.' : true;
      }
      const parsed = Number(value);
      if (Number.isNaN(parsed) || parsed < -90 || parsed > 90) {
        return 'Latitude must be between -90 and 90.';
      }
      return true;
    },
  });
  const longitudeRegistration = register('longitude', {
    validate: (value) => {
      if (!value.trim()) {
        return getValues('latitude').trim() ? 'Longitude is required when latitude is set.' : true;
      }
      const parsed = Number(value);
      if (Number.isNaN(parsed) || parsed < -180 || parsed > 180) {
        return 'Longitude must be between -180 and 180.';
      }
      return true;
    },
  });

  return (
    <form onSubmit={handleSubmit(onValid)} className="flex flex-col gap-4" noValidate aria-busy={isSubmitting}>
      <TextField
        label="Outlet name"
        placeholder="e.g. Main Canteen"
        error={errors.name?.message}
        {...nameRegistration}
      />

      {mode === 'create' ? (
        <div className="flex flex-col gap-1">
          <TextField
            label="Slug"
            placeholder="e.g. main-canteen"
            autoComplete="off"
            aria-describedby="outlet-slug-help"
            error={errors.slug?.message}
            {...slugRegistration}
          />
          <p id="outlet-slug-help" className="text-xs text-muted">
            Identifies this outlet within your organization. Lowercase letters, numbers, and
            hyphens only (3–50 characters). You won&apos;t be able to change this later.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          <TextField
            id="slug"
            label="Slug"
            value={props.outlet.slug}
            disabled
            readOnly
            aria-describedby="outlet-slug-help"
          />
          <p id="outlet-slug-help" className="text-xs text-muted">
            An outlet&apos;s slug can&apos;t be changed after it&apos;s created.
          </p>
        </div>
      )}

      <TextField
        label="Description"
        placeholder="Optional"
        error={errors.description?.message}
        {...descriptionRegistration}
      />

      <TextField
        label="Phone"
        placeholder="Optional"
        type="tel"
        error={errors.phone?.message}
        {...phoneRegistration}
      />

      <div className="flex flex-col gap-4 rounded-lg border border-border p-3">
        <p className="text-sm font-medium text-text">Address (optional)</p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <TextField label="Address line 1" error={errors.addressLine1?.message} {...addressLine1Registration} />
          <TextField label="Address line 2" error={errors.addressLine2?.message} {...addressLine2Registration} />
          <TextField label="City" error={errors.city?.message} {...cityRegistration} />
          <TextField label="State" error={errors.state?.message} {...stateRegistration} />
          <TextField label="Postal code" error={errors.postalCode?.message} {...postalCodeRegistration} />
        </div>
      </div>

      <div className="flex flex-col gap-4 rounded-lg border border-border p-3">
        <p className="text-sm font-medium text-text">Location (optional)</p>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <TextField
            label="Latitude"
            type="number"
            step="any"
            inputMode="decimal"
            error={errors.latitude?.message}
            {...latitudeRegistration}
          />
          <TextField
            label="Longitude"
            type="number"
            step="any"
            inputMode="decimal"
            error={errors.longitude?.message}
            {...longitudeRegistration}
          />
        </div>
      </div>

      {mode === 'edit' && (
        <Controller
          name="status"
          control={control}
          render={({ field }) => (
            <IonSelect
              label="Status"
              labelPlacement="stacked"
              interface="popover"
              value={field.value}
              onIonChange={(event) => field.onChange(event.detail.value as OutletStatus)}
            >
              <IonSelectOption value="active">Active</IonSelectOption>
              <IonSelectOption value="inactive">Inactive</IonSelectOption>
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
          {isSubmitting ? (mode === 'create' ? 'Adding…' : 'Saving…') : mode === 'create' ? 'Add Outlet' : 'Save changes'}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={isSubmitting}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
