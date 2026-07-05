import { reddit } from '@devvit/web/server';

export const createPost = async (title: string = 'Knockit — The board remembers everyone') => {
  return await reddit.submitCustomPost({
    title,
  });
};
