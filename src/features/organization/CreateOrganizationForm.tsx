import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react';
import { useForm } from 'react-hook-form';
import type { OrganizationWithRole } from '../../domain/types';
import { Button } from '../../components/ui/Button';
import { TextField } from '../../components/ui/TextField';
import { ApiError } from '../../lib/api/client';
import { SLUG_MAX_LENGTH, SLUG_MIN_LENGTH, SLUG_PATTERN, suggestSlug } from '../../utils/slug';
import type { CreateOrganizationInput } from './api';
import { organizationErrorMessage } from './errors';

const NAME_MAX_LENGTH = 100;

export interface CreateOrganizationFormProps {
  createOrganization: (input: CreateOrganizationInput) => Promise<OrganizationWithRole>;
  onCreated: () => void;
}

interface FormValues {
  name: string;
  slug: string;
}

export function CreateOrganizationForm({ createOrganization, onCreated }: CreateOrganizationFormProps) {
  const {
    register,
    handleSubmit,
    setValue,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ defaultValues: { name: '', slug: '' }, mode: 'onBlur' });

  const slugTouchedRef = useRef(false);
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

  const onSubmit = async (values: FormValues) => {
    setFormError(null);
    try {
      await createOrganization({ name: values.name.trim(), slug: values.slug.trim() });
      onCreated();
    } catch (error) {
      if (error instanceof ApiError && error.code === 'already_exists') {
        setError('slug', { type: 'manual', message: error.message });
        return;
      }
      setFormError(organizationErrorMessage(error));
    }
  };

  // react-hook-form's register() reads its internal field registry (a ref) synchronously by
  // design, which the compiler-safety `react-hooks/refs` rule can't verify is safe — it is,
  // since RHF (not React) owns that ref.
  // eslint-disable-next-line react-hooks/refs
  const nameRegistration = register('name', {
    required: 'Organization name is required.',
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

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4" noValidate aria-busy={isSubmitting}>
      <TextField
        label="Organization name"
        placeholder="e.g. KMCTCEM Café"
        autoComplete="organization"
        error={errors.name?.message}
        {...nameRegistration}
      />

      <div className="flex flex-col gap-1">
        <TextField
          label="Slug"
          placeholder="e.g. kmctcem-cafe"
          autoComplete="off"
          aria-describedby="slug-help"
          error={errors.slug?.message}
          {...slugRegistration}
        />
        <p id="slug-help" className="text-xs text-muted">
          Identifies your organization in Zesto. Lowercase letters, numbers, and hyphens
          only (3–50 characters). You won&apos;t be able to change this later.
        </p>
      </div>

      {formError && (
        <p ref={formErrorRef} role="alert" tabIndex={-1} className="text-sm text-danger outline-none">
          {formError}
        </p>
      )}

      <Button type="submit" disabled={isSubmitting}>
        {isSubmitting ? 'Creating…' : 'Create organization'}
      </Button>
    </form>
  );
}
