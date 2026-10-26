# 🌶️ Rota de Vendas

App web (roda no navegador do celular) para vendedor porta a porta: você diz onde está, ele mostra
todos os restaurantes por perto e monta a **melhor rota de carro** para visitar um por um.

## O que faz
- **Onde estou:** GPS do celular, endereço digitado ou toque no mapa.
- **Restaurantes por perto:** busca ao vivo no OpenStreetMap (restaurantes, lanchonetes, bares e,
  se quiser, padarias, cafés e açougues) num raio de 1 a 100 km.
- **Melhor rota:** pega os 99 mais próximos (limite do servidor de rotas) e calcula a ordem de visita
  que roda menos km em ruas reais (OSRM).
- **Navegação:** botão para abrir a rota inteira no Google Maps (dividida em trechos, porque o Google
  limita as paradas por link) e botões por restaurante para Google Maps, Waze e ligar.
- **Controle de visitas:** marque cada lugar como *Visitado*, *Interessado*, *Cliente* ou *Sem
  interesse* e escreva anotações (a cor aparece na lista e no mapa). Fica salvo no navegador; use **⋯ → Exportar backup** para levar para outro aparelho.
- **Baixar a rota em CSV** (abre no Excel).
- **Dados do Google Maps (scraper do kit):** telefone, nota e nº de avaliações, mais completos que o
  OpenStreetMap. Veja abaixo.

## TomTom ao vivo (grátis, sem cartão)
Com isso ligado, o app busca os restaurantes na base comercial da **TomTom** (empresa de GPS), mais
completa e atualizada que o OpenStreetMap. O OpenStreetMap vira só reserva, caso a TomTom falhe.

**Quanto gasta:** o plano grátis da TomTom dá **2.500 buscas por dia**, sem cartão de crédito. Cada busca
traz até 100 lugares: uma rota nova gasta 2 buscas (os 200 mais próximos) e a primeira vez no aparelho
gasta mais 1 para baixar a lista de categorias. A mesma busca fica no cache do celular por 7 dias.
O contador (menu ⋯) mostra quantas buscas você fez hoje e para no limite que você escolher (padrão 2.000).

A TomTom não tem nota nem avaliações: o botão **⭐ Ficha Google** de cada lugar abre a busca dele no
Google Maps, de graça.

### Criar a chave (uma vez, ~5 min)
1. Acesse https://developer.tomtom.com e clique em **Register** (pede nome, e-mail e senha; não pede cartão nem CPF).
2. Confirme o e-mail e entre no **Dashboard** (https://developer.tomtom.com/user/me/apps).
3. A TomTom já cria uma chave chamada *My first API key*. Clique nela e copie a chave.
4. Coloque a chave em `app/config.js` (`tomtomKey`), faça commit e push: o site já abre com a TomTom
   ligada em qualquer aparelho. Uma chave colada no menu **⋯** tem prioridade naquele aparelho.
5. **Importante:** `config.js` é público. No painel da TomTom, ligue o **Domain whitelist** da chave só
   para `tabaldi98.github.io` (e `localhost`, se for testar no PC), senão qualquer um pode gastar sua cota.

Passando de 2.500 buscas no dia, a TomTom só responde com erro (o app usa o OpenStreetMap); não há cobrança.

## Base salva da região (Grande Florianópolis)
`app/regiao-osm.json` guarda todos os restaurantes, lanchonetes, bares, padarias, cafés e açougues
do OpenStreetMap entre Tijucas, Biguaçu, Florianópolis, São José, Palhoça e Santo Amaro. Dentro dessa
área o app usa a base salva: a busca é instantânea e não depende dos servidores Overpass (que caem
bastante). Fora dela, busca ao vivo. Para atualizar a base (ou trocar de região):

```bash
py scripts/osm_region.py
py scripts/osm_region.py --bbox -27.95,-48.85,-27.15,-48.35 --name "Grande Florianópolis"
```

## Dados do Google Maps pelo scraper (opcional)
O scraper fica em outro projeto, o **Google Maps Scraper Kit** (`gosom/google-maps-scraper` em Docker),
e roda no seu computador, não no GitHub Pages. Você raspa em casa e traz o resultado para cá.
No kit, com o Docker aberto e o motor ligado (`docker compose up -d`):

```bash
py scripts/scrape_regiao.py
```

Busca restaurantes, lanchonetes, pizzarias, bares e churrascarias bairro por bairro em 10 cidades da
Grande Florianópolis, uma cidade por vez (1 a 3 horas; dá para parar com Ctrl+C e continuar depois),
e grava os CSVs em `gmaps-output/` do kit. Depois, escolha um dos dois caminhos:

1. **Só no seu celular (privado):** abra o app → **⋯ → Importar CSV** e escolha o CSV.
2. **Publicado no site (vale para qualquer aparelho):** neste repositório,
   ```bash
   py scripts/csv_to_app.py CAMINHO/DO/KIT/gmaps-output/*.csv
   ```
   Isso junta tudo em `app/restaurantes.json` (sem e-mails). Faça commit e push: o site atualiza sozinho.
   Atenção: esse arquivo fica **público** no GitHub Pages.

O CSV precisa das colunas `latitude` e `longitude` (o `scrape_regiao.py` já roda com `--full`).
Quando o mesmo restaurante vem de duas fontes, o app junta e fica com os dados do Google (telefone, nota).

## Publicação (GitHub Pages)
O site fica em **https://tabaldi98.github.io/maps-router-seller/** (abre o app em `app/`).
O GitHub Pages publica a branch `main` direto (**Settings → Pages → Deploy from a branch → main / root**):
cada push atualiza o site em 1 ou 2 minutos. O `.nojekyll` faz o GitHub servir os arquivos como estão.
No celular, abra o endereço e use **Adicionar à tela inicial** para ter como um app.
O GPS só funciona em HTTPS (o GitHub Pages já é).

## Testar no computador
```bash
py -m http.server 8765 --directory app
```
e abra http://localhost:8765.

## Serviços usados (gratuitos)
- Mapa e restaurantes: [OpenStreetMap](https://www.openstreetmap.org/copyright) via Overpass API.
  Os servidores Overpass às vezes ficam lentos: o app pergunta a 4 ao mesmo tempo e, se todos
  falharem, usa a busca Photon (acha menos lugares) e avisa na tela.
- Rotas: servidor público do [OSRM](https://project-osrm.org). Se cair, o app calcula a ordem em
  linha reta (rota tracejada no mapa).
- Endereços: Nominatim (OpenStreetMap).
- Restaurantes ao vivo (opcional): [TomTom Search API](https://docs.tomtom.com/search-api/documentation/search-service/nearby-search), plano grátis.

São serviços comunitários com limite de uso justo: ótimos para uso pessoal, não para centenas de usuários.
