/* どの短編からも使うページ */
HOMEAGE.add([
  {
    id: 'koujichu',
    place: '工事中',
    text: [
      '',
      '@6工事中',
      '',
      'このページは現在工事中です。',
      'つづきの短編は、まだ書かれていません。',
    ],
    choices: [{ text: 'ここまでのきろくを見る', to: 'kiroku' }],
  },
  {
    id: 'kiroku',
    place: 'きろく',
    special: 'kiroku',
    choices: [{ text: 'はじめから読む', to: '@reset' }],
  },
]);
