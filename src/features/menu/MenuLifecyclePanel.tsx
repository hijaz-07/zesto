import { useState } from 'react';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { cn } from '../../lib/cn';
import { formatDate, formatTime } from '../../utils/date';
import { canPublishMenu } from './editPermissions';
import { menuErrorMessage } from './errors';
import type { Menu } from './types';

export interface MenuLifecyclePanelProps {
  menu: Menu;
  /** Total item count and currently-enabled item count, from `useMenuItems()` — kept as plain numbers so this component never needs to know the item shape. */
  itemCount: number;
  enabledItemCount: number;
  /** Whether `useMenuItems()` has finished its initial load; the checklist and Publish button stay conservative (disabled) until it has. */
  itemsReady: boolean;
  outletActive: boolean;
  /** Whether the caller's organization role (owner/manager) may publish/archive — see `canManageMenu`. Staff renders nothing here at all, not just a disabled button, since Publish/Archive are mutation controls staff must not see (backend still rejects independently, 403). */
  canManage: boolean;
  onPublish: () => Promise<Menu>;
  onArchive: () => Promise<Menu>;
}

interface ChecklistItemProps {
  ok: boolean;
  label: string;
}

function ChecklistItem({ ok, label }: ChecklistItemProps) {
  return (
    <li className={cn('flex items-start gap-2 text-sm', ok ? 'text-text' : 'text-danger')}>
      <span aria-hidden="true">{ok ? '✓' : '✗'}</span>
      <span>
        <span className="sr-only">{ok ? 'Passed: ' : 'Failed: '}</span>
        <span>{label}</span>
      </span>
    </li>
  );
}

/**
 * The menu editor's Publish/Archive workflow. Renders nothing for an
 * archived menu (read-only: no publish, no archive — see the Step 8J spec's
 * "DETAIL PAGE ACTIONS"), and nothing at all for a caller who can't manage
 * menus (`!canManage`, i.e. staff) — this is a mutation-only panel, so there
 * is no read-only view of it to fall back to. The checklist is UX only,
 * mirroring `functions/src/domain/menus.ts#publishMenu`'s real gates (draft
 * status, schedule validity, at least one enabled item) plus the
 * outlet-active requirement `routes/menus.ts#handlePostPublish` enforces and
 * the `MANAGE_ROLES` role check both route handlers apply before either —
 * the backend remains the sole authority and is re-checked on every submit.
 */
export function MenuLifecyclePanel({
  menu,
  itemCount,
  enabledItemCount,
  itemsReady,
  outletActive,
  canManage,
  onPublish,
  onArchive,
}: MenuLifecyclePanelProps) {
  const [confirmingPublish, setConfirmingPublish] = useState(false);
  const [publishPending, setPublishPending] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);

  const [confirmingArchive, setConfirmingArchive] = useState(false);
  const [archivePending, setArchivePending] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);

  const handleConfirmPublish = async () => {
    setPublishError(null);
    setPublishPending(true);
    try {
      await onPublish();
      setConfirmingPublish(false);
    } catch (error) {
      setPublishError(menuErrorMessage(error));
    } finally {
      setPublishPending(false);
    }
  };

  const handleConfirmArchive = async () => {
    setArchiveError(null);
    setArchivePending(true);
    try {
      await onArchive();
      setConfirmingArchive(false);
    } catch (error) {
      setArchiveError(menuErrorMessage(error));
    } finally {
      setArchivePending(false);
    }
  };

  if (!canManage || menu.status === 'archived') {
    return null;
  }

  if (menu.status === 'published') {
    return (
      <Card className="flex flex-col gap-3">
        {confirmingArchive ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm font-medium text-text">Archive this menu?</p>
            <div className="text-sm text-muted">
              <p>This menu will become read-only.</p>
              <p>Its historical information will remain available.</p>
            </div>
            {archiveError && (
              <p role="alert" className="text-sm text-danger">
                {archiveError}
              </p>
            )}
            <div className="flex items-center gap-2">
              <Button variant="danger" disabled={archivePending} onClick={handleConfirmArchive}>
                {archivePending ? 'Archiving…' : 'Archive Menu'}
              </Button>
              <Button
                type="button"
                variant="ghost"
                disabled={archivePending}
                onClick={() => {
                  setConfirmingArchive(false);
                  setArchiveError(null);
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <Button variant="danger" onClick={() => setConfirmingArchive(true)}>
            Archive Menu
          </Button>
        )}
      </Card>
    );
  }

  // menu.status === 'draft'
  const publishAllowed = itemsReady && enabledItemCount > 0 && canPublishMenu(menu.status, outletActive);

  return (
    <Card className="flex flex-col gap-3">
      {confirmingPublish ? (
        <div className="flex flex-col gap-3">
          <p className="text-sm font-medium text-text">Publish this menu?</p>
          <div className="text-sm text-text">
            <p>{menu.title}</p>
            <p>{formatDate(menu.menuDate)}</p>
          </div>
          <div className="text-sm text-text">
            <p>{enabledItemCount} enabled</p>
            <p>{itemCount} total</p>
          </div>
          <div className="text-sm text-text">
            <p>Ordering:</p>
            <p>
              {formatTime(menu.orderingOpensAt)} – {formatTime(menu.orderingClosesAt)}
            </p>
          </div>
          <div className="text-sm text-text">
            <p>Pickup:</p>
            <p>
              {formatTime(menu.pickupStartsAt)} – {formatTime(menu.pickupEndsAt)}
            </p>
          </div>
          <p className="text-sm text-muted">
            After publishing, the menu will be visible to customers according to its ordering schedule.
          </p>
          {publishError && (
            <p role="alert" className="text-sm text-danger">
              {publishError}
            </p>
          )}
          <div className="flex items-center gap-2">
            <Button disabled={publishPending} onClick={handleConfirmPublish}>
              {publishPending ? 'Publishing…' : 'Publish Menu'}
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={publishPending}
              onClick={() => {
                setConfirmingPublish(false);
                setPublishError(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <>
          <p className="text-sm font-medium text-text">Publish checklist</p>
          <ul className="flex flex-col gap-1">
            <ChecklistItem ok label="Menu details valid" />
            <ChecklistItem ok label="Ordering schedule valid" />
            <ChecklistItem ok label="Pickup schedule valid" />
            {itemsReady ? (
              <>
                <ChecklistItem ok={itemCount > 0} label={`${itemCount} menu item${itemCount === 1 ? '' : 's'}`} />
                <ChecklistItem
                  ok={enabledItemCount > 0}
                  label={enabledItemCount > 0 ? 'At least 1 enabled item' : 'At least 1 enabled item required'}
                />
              </>
            ) : (
              <li className="text-sm text-muted">Checking menu items…</li>
            )}
          </ul>
          {itemsReady && enabledItemCount === 0 && (
            <p className="text-xs text-muted">Add at least one enabled menu item before publishing.</p>
          )}
          <div>
            <Button disabled={!publishAllowed} onClick={() => setConfirmingPublish(true)}>
              Publish Menu
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}
