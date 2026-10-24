import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/form';
import { Dialog, DialogContent, Select } from '@/components/ui/primitives';
import { useCustomers } from '@/hooks';
import { api, errorMessage } from '@/lib/api';

const NONE = '__none__';

export function NewConversationDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const customers = useCustomers();
  const [customerId, setCustomerId] = useState('');
  const [orderId, setOrderId] = useState(NONE);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const customer = customers.data?.find((c) => c.id === customerId);

  const create = useMutation({
    mutationFn: () =>
      api.post<{ conversation: { id: string } }>('/api/conversations', {
        customer_id: customerId,
        order_id: orderId === NONE ? null : orderId,
      }),
    onSuccess: ({ conversation }) => {
      void queryClient.invalidateQueries({ queryKey: ['conversations'] });
      onOpenChange(false);
      setCustomerId('');
      setOrderId(NONE);
      navigate(`/conversations/${conversation.id}`);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="New conversation" description="Start a conversation with a customer of one of your brands.">
        <div className="space-y-4">
          <Field label="Customer" htmlFor="new-customer">
            <Select
              id="new-customer"
              value={customerId}
              onValueChange={(v) => {
                setCustomerId(v);
                setOrderId(NONE);
              }}
              placeholder={customers.isPending ? 'Loading…' : 'Choose a customer'}
              options={(customers.data ?? []).map((c) => ({ value: c.id, label: `${c.name} (${c.email})` }))}
            />
          </Field>
          <Field label="Order (optional)" htmlFor="new-order" hint="Linking an order lets the assistant use verified order facts.">
            <Select
              id="new-order"
              value={orderId}
              onValueChange={setOrderId}
              disabled={!customer}
              options={[
                { value: NONE, label: 'No order' },
                ...(customer?.orders ?? []).map((o) => ({ value: o.id, label: `${o.order_number} · ${o.status}` })),
              ]}
            />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button disabled={!customerId} loading={create.isPending} onClick={() => create.mutate()}>
              Start conversation
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
