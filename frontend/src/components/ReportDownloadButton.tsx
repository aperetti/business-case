import { useState } from 'react';
import { Button, type ButtonProps } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconFileSpreadsheet, IconFileTypePdf } from '@tabler/icons-react';

interface Props extends Omit<ButtonProps, 'onClick' | 'loading' | 'leftSection'> {
  /** Starts the download; rejects with an Error on failure. */
  download: () => Promise<void>;
  label?: string;
  /** Icon shown on the button. */
  fileType?: 'pdf' | 'excel';
  /** Native tooltip text. */
  title?: string;
}

/** Button that downloads a generated file (PDF or Excel), with a loading state and error toast. */
export function ReportDownloadButton({ download, label = 'PDF Report', fileType = 'pdf', ...rest }: Props) {
  const [busy, setBusy] = useState(false);

  const handleClick = async () => {
    setBusy(true);
    try {
      await download();
    } catch (err) {
      notifications.show({
        color: 'red',
        title: 'Download failed',
        message: err instanceof Error ? err.message : 'Could not generate the file.',
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
      leftSection={fileType === 'excel' ? <IconFileSpreadsheet size={15} /> : <IconFileTypePdf size={15} />}
      onClick={handleClick}
    >
      {label}
    </Button>
  );
}
