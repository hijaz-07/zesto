import { useState } from 'react';
import { IonIcon } from '@ionic/react';
import { createOutline, trashOutline } from 'ionicons/icons';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { formatPaiseAsRupees } from '../../utils/currency';
import type { MenuItemMutationPermissions } from '../menu/editPermissions';
import { menuItemErrorMessage } from './errors';
import type { MenuItem } from './types';

export interface MenuItemCardProps {
  item: MenuItem;
  permissions: MenuItemMutationPermissions;
  onEdit: () => void;
  onToggleEnabled: () => Promise<void>;
  onDelete: () => Promise<void>;
}

/**
 * One menu item in the organization's item-management list. Always shows
 * the item regardless of `enabled` — disabled items must remain visible to
 * the organization (see `MenuItemsSection`) — and only renders the actions
 * `permissions` currently allows. Owns its own delete-confirmation and
 * enable/disable/delete pending/error state, since a rejected mutation here
 * must leave this specific card's item visible and unchanged (see root
 * CLAUDE.md's "never trust the frontend" and the Step 8J spec's delete/
 * enable-disable error handling) without disturbing any other card.
 */
export function MenuItemCard({ item, permissions, onEdit, onToggleEnabled, onDelete }: MenuItemCardProps) {
  const [togglePending, setTogglePending] = useState(false);
  const [toggleError, setToggleError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deletePending, setDeletePending] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const handleToggle = async () => {
    setToggleError(null);
    setTogglePending(true);
    try {
      await onToggleEnabled();
    } catch (error) {
      setToggleError(menuItemErrorMessage(error));
    } finally {
      setTogglePending(false);
    }
  };

  const handleConfirmDelete = async () => {
    setDeleteError(null);
    setDeletePending(true);
    try {
      await onDelete();
    } catch (error) {
      setDeleteError(menuItemErrorMessage(error));
      setDeletePending(false);
    }
  };

  return (
    <Card className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="font-medium text-text">{item.name}</h3>
          {item.description && <p className="text-sm text-muted">{item.description}</p>}
        </div>
        <Badge tone={item.enabled ? 'success' : 'neutral'}>{item.enabled ? 'ACTIVE' : 'DISABLED'}</Badge>
      </div>

      <dl className="grid grid-cols-2 gap-2 text-sm">
        <div>
          <dt className="text-xs uppercase tracking-wide text-muted">Price</dt>
          <dd className="text-text">{formatPaiseAsRupees(item.priceInPaise)}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-muted">Display order</dt>
          <dd className="text-text">{item.displayOrder}</dd>
        </div>
      </dl>

      {confirmingDelete ? (
        <div className="flex flex-col gap-2 rounded-lg bg-background p-3">
          <p className="text-sm font-medium text-text">Delete &ldquo;{item.name}&rdquo;?</p>
          <p className="text-sm text-muted">This item has not been published yet.</p>
          {deleteError && (
            <p role="alert" className="text-sm text-danger">
              {deleteError}
            </p>
          )}
          <div className="flex items-center gap-2">
            <Button variant="danger" disabled={deletePending} onClick={handleConfirmDelete}>
              {deletePending ? 'Deleting…' : 'Delete'}
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={deletePending}
              onClick={() => {
                setConfirmingDelete(false);
                setDeleteError(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {permissions.canEdit && (
            <Button variant="secondary" onClick={onEdit} aria-label={`Edit ${item.name}`}>
              <IonIcon icon={createOutline} />
              Edit
            </Button>
          )}
          {permissions.canToggleEnabled && (
            <Button
              variant="secondary"
              disabled={togglePending}
              onClick={handleToggle}
              aria-label={`${item.enabled ? 'Disable' : 'Enable'} ${item.name}`}
            >
              {togglePending ? 'Updating…' : item.enabled ? 'Disable' : 'Enable'}
            </Button>
          )}
          {permissions.canDelete && (
            <Button variant="danger" onClick={() => setConfirmingDelete(true)} aria-label={`Delete ${item.name}`}>
              <IonIcon icon={trashOutline} />
              Delete
            </Button>
          )}
        </div>
      )}

      {toggleError && (
        <p role="alert" className="text-sm text-danger">
          {toggleError}
        </p>
      )}
    </Card>
  );
}
