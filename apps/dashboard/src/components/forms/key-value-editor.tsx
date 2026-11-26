'use client';
import { Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export interface KeyValue {
  key: string;
  value: string;
}

export function KeyValueEditor({ rows, onChange, keyPlaceholder = 'Header', valuePlaceholder = 'Value' }: { rows: KeyValue[]; onChange: (rows: KeyValue[]) => void; keyPlaceholder?: string; valuePlaceholder?: string }) {
  return (
    <div className="space-y-2">
      {rows.map((row, index) => (
        <div key={index} className="flex gap-2">
          <Input aria-label={`${keyPlaceholder} ${index + 1}`} placeholder={keyPlaceholder} value={row.key} className="font-mono" onChange={(event) => onChange(rows.map((item, i) => (i === index ? { ...item, key: event.target.value } : item)))} />
          <Input aria-label={`${valuePlaceholder} ${index + 1}`} placeholder={valuePlaceholder} value={row.value} className="font-mono" onChange={(event) => onChange(rows.map((item, i) => (i === index ? { ...item, value: event.target.value } : item)))} />
          <Button type="button" variant="ghost" size="icon" aria-label={`Remove ${keyPlaceholder} ${index + 1}`} onClick={() => onChange(rows.filter((_, i) => i !== index))}><Trash2 /></Button>
        </div>
      ))}
      <Button type="button" variant="secondary" size="sm" onClick={() => onChange([...rows, { key: '', value: '' }])}><Plus /> Add {keyPlaceholder.toLowerCase()}</Button>
    </div>
  );
}
