import { useState, type ReactNode } from 'react';
import { IonIcon } from '@ionic/react';
import { addOutline } from 'ionicons/icons';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { EmptyState } from '../../components/common/EmptyState';
import { ErrorState } from '../../components/common/ErrorState';
import { LoadingState } from '../../components/common/LoadingState';
import type { MenuItemMutationPermissions } from '../menu/editPermissions';
import { menuItemErrorMessage } from './errors';
import { MenuItemCard } from './MenuItemCard';
import { MenuItemForm } from './MenuItemForm';
import type { MenuItem } from './types';
import type { UseMenuItemsResult } from './useMenuItems';

export interface MenuItemsSectionProps {
  itemsResult: UseMenuItemsResult;
  permissions: MenuItemMutationPermissions;
}

type ItemsView = { mode: 'list' } | { mode: 'create' } | { mode: 'edit'; item: MenuItem };

/**
 * The menu editor's "Menu Items" card: list, create, and edit, mirroring
 * `OrganizationOutletsPage`'s own list/create/edit view-switching shape.
 * Disabled items are always shown, never hidden — `enabled: false` means
 * "customers can't order this," not "removed." Item order always follows
 * `itemsResult.items` exactly as `useMenuItems()` returned it; this never
 * sorts or reorders that array itself (no drag-and-drop in this step).
 */
export function MenuItemsSection({ itemsResult, permissions }: MenuItemsSectionProps) {
  const { status, items, error, retry, createMenuItem, updateMenuItem, deleteMenuItem } = itemsResult;
  const [view, setView] = useState<ItemsView>({ mode: 'list' });

  const showList = () => setView({ mode: 'list' });
  const startCreate = () => setView({ mode: 'create' });

  let content: ReactNode;
  if (view.mode === 'create') {
    content = (
      <MenuItemForm
        mode="create"
        defaultDisplayOrder={items.length}
        onSubmit={createMenuItem}
        onSaved={showList}
        onCancel={showList}
      />
    );
  } else if (view.mode === 'edit') {
    const { item } = view;
    content = (
      <MenuItemForm
        mode="edit"
        item={item}
        onSubmit={(input) => updateMenuItem(item.id, input)}
        onSaved={showList}
        onCancel={showList}
      />
    );
  } else if (status === 'loading') {
    content = <LoadingState label="Loading menu items…" />;
  } else if (status === 'error') {
    content = (
      <ErrorState
        title="Couldn't load menu items"
        description={menuItemErrorMessage(error)}
        action={<Button onClick={retry}>Try again</Button>}
      />
    );
  } else if (items.length === 0) {
    content = (
      <EmptyState
        title="No menu items yet."
        description="Add the first item to this menu."
        action={
          permissions.canAdd ? (
            <Button onClick={startCreate}>
              <IonIcon icon={addOutline} />
              Add Item
            </Button>
          ) : undefined
        }
      />
    );
  } else {
    content = (
      <div className="flex flex-col gap-3">
        {items.map((item) => (
          <MenuItemCard
            key={item.id}
            item={item}
            permissions={permissions}
            onEdit={() => setView({ mode: 'edit', item })}
            onToggleEnabled={async () => {
              await updateMenuItem(item.id, { enabled: !item.enabled });
            }}
            onDelete={() => deleteMenuItem(item.id)}
          />
        ))}
      </div>
    );
  }

  const title = view.mode === 'create' ? 'Add Item' : view.mode === 'edit' ? 'Edit Item' : 'Menu Items';

  return (
    <Card className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium text-text">{title}</p>
        {view.mode === 'list' && status === 'ready' && permissions.canAdd && (
          <Button onClick={startCreate}>
            <IonIcon icon={addOutline} />
            Add Item
          </Button>
        )}
      </div>
      {content}
    </Card>
  );
}
