/* どの短編からも使うページ */
HOMEAGE.add([
  {
    id: 'koujichu',
    place: 'この先',
    text: [
      '',
      '@5この先は、まだ工事中です。',
      '',
      'つづきの短編は、まだ書かれていません。',
    ],
    choices: [{ text: 'ここまでのきろくを見る', to: 'kiroku' }],
  },
  {
    id: 'kiroku',
    place: 'きろく',
    special: 'kiroku',
    ui: { type: 'buttons' },
    choices: [{ text: 'はじめから読む', to: '@reset' }],
  },
]);
