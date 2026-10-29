import type { Meta, StoryObj } from '@storybook/react-vite';
import { Button, Card } from '../index';
import { Phone } from './frames';

const meta = { title: 'Components/Card', component: Card } satisfies Meta<typeof Card>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    children: (
      <>
        <h2 style={{ marginTop: 0 }}>Sign in</h2>
        <p>Use your institution email address.</p>
        <Button block>Continue</Button>
      </>
    ),
  },
};

export const LongContentOnPhone: Story = {
  args: {
    children: (
      <p style={{ margin: 0 }}>
        Adébáyọ̀ Olúwaṣeun Chukwuemeka-Ìyáńlá, Department of Electrical and Electronics Engineering, Faculty of
        Engineering and Technology, matriculation number ENG/2024/000123456.
      </p>
    ),
  },
  decorators: [(S) => <Phone><S /></Phone>],
};
