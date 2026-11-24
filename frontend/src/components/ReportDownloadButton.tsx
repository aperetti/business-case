import { useState } from 'react';
import { Button, type ButtonProps } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconFileTypePdf } from '@tabler/icons-react';

interface Props extends Omit<ButtonProps, 'onClick' | 'loading' | 'leftSection'> {
  /** Starts the download; rejects with an Error on failure. */
  download: () => Promise<void>;
  label?: string;
}

/** Button that downloads a generated PDF report, with a loading state and error toast. */
export function ReportDownloadButton({ download, label = 'PDF Report', ...rest }: Props) {
  const [busy, setBusy] = useState(false);

  const handleClick = async () => {
    setBusy(true);
    try {
      await download();
    } catch (err) {
      notifications.show({
        color: 'red',
        title: 'Report failed',
        message: err instanceof Error ? err.message : 'Could not generate the PDF report.',
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Button
      type="button"
      variant="default"
      {...rest}
      loading={busy}
      leftSection={<IconFileTypePdf size={15} />}
      onClick={handleClick}
    >
      {label}
    </Button>
  );
}
